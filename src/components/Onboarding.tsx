import { useState, useRef } from 'react';
import { supabase, type InstitutionType } from '../lib/supabase';
import { Sparkles, ArrowRight, ArrowLeft, Loader2, GraduationCap, School, Building2, Cake, Sun, Moon, Camera } from 'lucide-react';

type Step = 'name' | 'age' | 'institution' | 'school' | 'avatar';

const INSTITUTIONS: { id: InstitutionType; label: string; desc: string; icon: React.ReactNode }[] = [
  { id: 'jhs', label: 'Junior High', desc: 'Grades / years before high school', icon: <School className="h-6 w-6" /> },
  { id: 'shs', label: 'Senior High', desc: 'High school / secondary', icon: <GraduationCap className="h-6 w-6" /> },
  { id: 'uni', label: 'University', desc: 'College / university', icon: <Building2 className="h-6 w-6" /> },
];

export function Onboarding({
  userId,
  onDone,
  theme,
  onToggleTheme,
}: {
  userId: string;
  onDone: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const [step, setStep] = useState<Step>('name');
  const [displayName, setDisplayName] = useState('');
  const [age, setAge] = useState('');
  const [institution, setInstitution] = useState<InstitutionType | null>(null);
  const [schoolName, setSchoolName] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const steps: Step[] = ['name', 'age', 'institution', 'school', 'avatar'];
  const stepIndex = steps.indexOf(step);
  const totalSteps = steps.length;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 2 * 1024 * 1024) {
        setError('Image size must be less than 2MB.');
        return;
      }
      setAvatarFile(file);
      setAvatarPreview(URL.createObjectURL(file));
    }
  };

  const next = () => {
    setError(null);
    if (step === 'name') {
      if (!displayName.trim()) return setError('Pick a display name.');
      setStep('age');
    } else if (step === 'age') {
      const a = parseInt(age, 10);
      if (isNaN(a) || a < 13 || a > 100) return setError('Enter a valid age (13–100).');
      setStep('institution');
    } else if (step === 'institution') {
      if (!institution) return setError('Choose your institution type.');
      setStep('school');
    } else if (step === 'school') {
      setStep('avatar');
    }
  };

  const back = () => {
    setError(null);
    if (step === 'age') setStep('name');
    else if (step === 'institution') setStep('age');
    else if (step === 'school') setStep('institution');
    else if (step === 'avatar') setStep('school');
  };

  const finish = async () => {
    setError(null);
    setLoading(true);
    let uploadedAvatarUrl: string | null = null;

    try {
      if (avatarFile) {
        const fileExt = avatarFile.name.split('.').pop();
        const filePath = `${userId}/${Date.now()}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, avatarFile, { 
            upsert: true,
            contentType: avatarFile.type 
          });

        if (uploadError) throw uploadError;

        const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
        uploadedAvatarUrl = data?.publicUrl || null;
      }

      const { error } = await supabase.from('profiles').insert({
        user_id: userId,
        display_name: displayName.trim(),
        age: parseInt(age, 10),
        institution_type: institution,
        school_name: schoolName.trim() || null,
        avatar_url: uploadedAvatarUrl,
      });
      
      if (error) throw error;
      onDone();
    } catch (err: any) {
      setError(err.message || 'Failed to save profile.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <button
        onClick={onToggleTheme}
        aria-label="Toggle theme"
        className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-bg-elev text-ink-muted transition hover:text-ink"
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>

      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/20">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-2xl font-bold text-ink">Let’s set you up</h2>
          <p className="mt-1 text-sm text-ink-muted">A few questions so we can match you well.</p>
        </div>

        <div className="mb-6 flex gap-1.5">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
                i <= stepIndex ? 'bg-accent' : 'bg-bg-muted'
              }`}
            />
          ))}
        </div>

        <div className="rounded-2xl border border-line bg-bg-elev p-6 shadow-2xl">
          {step === 'name' && (
            <StepShell icon={<Sparkles className="h-5 w-5" />} title="What should we call you?">
              <input
                autoFocus
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && next()}
                placeholder="Display name"
                className="w-full rounded-xl border border-line bg-bg px-4 py-3.5 text-ink placeholder-ink-faint focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50"
              />
              <p className="mt-2 text-xs text-ink-faint">This is shown to your chat partners.</p>
            </StepShell>
          )}

          {step === 'age' && (
            <StepShell icon={<Cake className="h-5 w-5" />} title="How old are you?">
              <input
                autoFocus
                type="number"
                min={13}
                max={100}
                value={age}
                onChange={(e) => setAge(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && next()}
                placeholder="e.g. 17"
                className="w-full rounded-xl border border-line bg-bg px-4 py-3.5 text-ink placeholder-ink-faint focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50"
              />
              <p className="mt-2 text-xs text-ink-faint">We use this to match you with people your age. You must be 13+.</p>
            </StepShell>
          )}

          {step === 'institution' && (
            <StepShell icon={<GraduationCap className="h-5 w-5" />} title="Where do you study?">
              <div className="space-y-2">
                {INSTITUTIONS.map((inst) => (
                  <button
                    key={inst.id}
                    onClick={() => {
                      setInstitution(inst.id);
                      setError(null);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition active:scale-[0.99] ${
                      institution === inst.id
                        ? 'border-accent/60 bg-accent/10'
                        : 'border-line bg-bg hover:bg-bg-muted'
                    }`}
                  >
                    <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${institution === inst.id ? 'bg-accent/20 text-accent' : 'bg-bg-muted text-ink-muted'}`}>
                      {inst.icon}
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium text-ink">{inst.label}</span>
                      <span className="text-xs text-ink-faint">{inst.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </StepShell>
          )}

          {step === 'school' && (
            <StepShell icon={<Building2 className="h-5 w-5" />} title="Name of your school?">
              <input
                autoFocus
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && next()}
                placeholder="e.g. Lincoln High (optional)"
                className="w-full rounded-xl border border-line bg-bg px-4 py-3.5 text-ink placeholder-ink-faint focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50"
              />
              <p className="mt-2 text-xs text-ink-faint">Optional, but helps match you with classmates.</p>
            </StepShell>
          )}

          {step === 'avatar' && (
            <StepShell icon={<Camera className="h-5 w-5" />} title="Add a profile picture">
              <div className="flex flex-col items-center justify-center py-4">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/*"
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="group relative flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border border-dashed border-line bg-bg transition hover:bg-bg-muted focus:outline-none"
                >
                  {avatarPreview ? (
                    <img src={avatarPreview} alt="Avatar preview" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex flex-col items-center text-ink-faint transition group-hover:text-ink-muted">
                      <Camera className="h-6 w-6 mb-1" />
                      <span className="text-xs">Upload image</span>
                    </div>
                  )}
                </button>
                <p className="mt-3 text-center text-xs text-ink-faint">Optional. Max file size: 2MB.</p>
              </div>
            </StepShell>
          )}

          {error && (
            <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-200">
              {error}
            </p>
          )}

          <div className="mt-5 flex items-center gap-2">
            {step !== 'name' && (
              <button
                type="button"
                onClick={back}
                className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-bg px-4 py-3 text-sm font-medium text-ink-muted transition hover:text-ink"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            )}
            {step !== 'avatar' ? (
              <button
                type="button"
                onClick={next}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-2 py-3 text-sm font-semibold text-white transition hover:scale-[1.02] active:scale-[0.99]"
              >
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={finish}
                disabled={loading}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-2 py-3 text-sm font-semibold text-white transition hover:scale-[1.02] active:scale-[0.99] disabled:opacity-50 disabled:hover:scale-100"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Finish <ArrowRight className="h-4 w-4" /></>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepShell({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">{icon}</span>
        <h3 className="text-base font-semibold text-ink">{title}</h3>
      </div>
      {children}
    </div>
  );
}