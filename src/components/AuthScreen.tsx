import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Sparkles, Mail, Lock, Loader2, ArrowRight, Sun, Moon } from 'lucide-react';

export function AuthScreen({
  theme,
  onToggleTheme,
}: {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError('Please enter your email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
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
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/20">
            <Sparkles className="h-7 w-7" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">RandomLink</h1>
          <p className="mt-2 text-sm text-ink-muted">Talk to strangers. Matched by who you vibe with.</p>
        </div>

        <div className="rounded-2xl border border-line bg-bg-elev p-6 shadow-2xl">
          <div className="mb-5 flex rounded-xl bg-bg-muted p-1">
            <button
              onClick={() => setMode('signup')}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                mode === 'signup' ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'
              }`}
            >
              Create account
            </button>
            <button
              onClick={() => setMode('signin')}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                mode === 'signin' ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'
              }`}
            >
              Sign in
            </button>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <Field icon={<Mail className="h-4 w-4" />} type="email" placeholder="you@example.com" value={email} onChange={setEmail} />
            <Field icon={<Lock className="h-4 w-4" />} type="password" placeholder="Password (min 6 chars)" value={password} onChange={setPassword} />

            {error && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-2 py-3.5 text-sm font-semibold text-white shadow-lg shadow-accent/20 transition hover:scale-[1.02] active:scale-[0.99] disabled:opacity-50 disabled:hover:scale-100"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (
                <>
                  {mode === 'signup' ? 'Create account' : 'Sign in'}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-ink-faint">
            {mode === 'signup' ? 'After signing up, we’ll ask a few questions to match you.' : 'Welcome back.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({
  icon,
  type,
  placeholder,
  value,
  onChange,
}: {
  icon: React.ReactNode;
  type: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">{icon}</span>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-line bg-bg py-3.5 pl-10 pr-4 text-ink placeholder-ink-faint focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50"
      />
    </div>
  );
}
