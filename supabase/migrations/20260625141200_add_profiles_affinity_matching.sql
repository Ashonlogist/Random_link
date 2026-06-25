-- Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  age int NOT NULL CHECK (age >= 13 AND age <= 100),
  institution_type text NOT NULL CHECK (institution_type IN ('jhs','shs','uni')),
  school_name text,
  display_name text NOT NULL DEFAULT 'Anonymous',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profile_select_own" ON public.profiles;
CREATE POLICY "profile_select_own" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "profile_insert_own" ON public.profiles;
CREATE POLICY "profile_insert_own" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "profile_update_own" ON public.profiles;
CREATE POLICY "profile_update_own" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "profile_delete_own" ON public.profiles;
CREATE POLICY "profile_delete_own" ON public.profiles FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Create affinity_history table
CREATE TABLE IF NOT EXISTS public.affinity_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_institution_type text NOT NULL,
  partner_age_band text NOT NULL,
  partner_school_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on affinity_history
ALTER TABLE public.affinity_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ah_select_own" ON public.affinity_history;
CREATE POLICY "ah_select_own" ON public.affinity_history FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "ah_insert_own" ON public.affinity_history;
CREATE POLICY "ah_insert_own" ON public.affinity_history FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_ah_user ON public.affinity_history (user_id, created_at);

-- Add Realtime safely
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.affinity_history;
EXCEPTION WHEN others THEN null; END $$;

-- Helper function: maps age to a specific band bucket
CREATE OR REPLACE FUNCTION public.age_band(p_age int)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_age < 16 THEN 'under16'
    WHEN p_age <= 17 THEN '16_17'
    WHEN p_age <= 22 THEN '18_22'
    ELSE '23_plus'
  END
$$;

-- Core Matching Algorithm Engine RPC
CREATE OR REPLACE FUNCTION public.match_partner(p_mode text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
  v_my_inst text;
  v_my_age_band text;
  v_my_school text;
  v_score int;
  v_best_id uuid;
  v_best_score int := -1;
  v_row record;
  v_w_inst numeric := 1.0;
  v_w_age numeric := 1.0;
  v_w_school numeric := 1.0;
BEGIN
  IF v_me IS NULL THEN RETURN NULL; END IF;

  -- Load the caller's profile attributes
  SELECT institution_type, school_name INTO v_my_inst, v_my_school FROM public.profiles WHERE user_id = v_me;
  v_my_age_band := public.age_band((SELECT age FROM public.profiles WHERE user_id = v_me));

  -- Track matching history weights to scale current preferences
  SELECT
    COALESCE(sum(CASE WHEN partner_institution_type = v_my_inst THEN 1 ELSE 0 END), 0),
    COALESCE(sum(CASE WHEN partner_age_band = v_my_age_band THEN 1 ELSE 0 END), 0),
    COALESCE(sum(CASE WHEN partner_school_name IS NOT NULL AND partner_school_name = v_my_school THEN 1 ELSE 0 END), 0)
  INTO v_w_inst, v_w_age, v_w_school
  FROM public.affinity_history WHERE user_id = v_me AND created_at > now() - interval '30 days';

  v_w_inst := 1.0 + v_w_inst;
  v_w_age := 1.0 + v_w_age;
  v_w_school := 1.0 + v_w_school;

  -- Loop through candidates in the queue
  FOR v_row IN
    SELECT w.user_id, p.institution_type AS inst, p.school_name AS school, p.age AS age
    FROM public.waiting_room w
    JOIN public.profiles p ON p.user_id = w.user_id
    WHERE w.mode = p_mode AND w.user_id <> v_me
    ORDER BY w.created_at ASC
  LOOP
    v_score := 0;
    IF v_row.inst = v_my_inst THEN v_score := v_score + (3 * v_w_inst)::int; END IF;
    IF public.age_band(v_row.age) = v_my_age_band THEN v_score := v_score + (3 * v_w_age)::int; END IF;
    IF v_row.school IS NOT NULL AND v_row.school = v_my_school THEN v_score := v_score + (4 * v_w_school)::int; END IF;

    IF v_score > v_best_score THEN
      v_best_score := v_score;
      v_best_id := v_row.user_id;
    END IF;
  END LOOP;

  RETURN v_best_id;
END;
$$;

-- Expressly grant execution permissions to client keys
GRANT EXECUTE ON FUNCTION public.match_partner(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.age_band(int) TO authenticated, anon;