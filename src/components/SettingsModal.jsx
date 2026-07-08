import { useState, useEffect, useMemo } from 'react';
import { X, Check, Settings, AtSign, User, Languages, Eye, LogOut, AlertCircle, ChevronDown } from 'lucide-react';
import { LANGUAGES } from '../lib/vocabularies';
import {
  getAccountSettings,
  updateDiscoverability,
  changeUsername,
  setDisplayName,
  setPreferredLanguage,
  usernameChangeEligibility,
} from '../lib/settings';

/*
========================================================
⚙️ SETTINGS MODAL
========================================================
One place to edit the account: username (the once-a-year change), display name,
preferred language, and discoverability. Opened from the app-bar gear (App.jsx).
Sign-out lives here (relocated out of the app bar).

Enforcement split (see lib/settings.js): discoverability is a direct own-row
UPDATE on account_settings (RLS-gated); display name / language / username go
through SECURITY DEFINER RPCs so validation is server-side.

Username change is gated: change_username() allows one change per 365 days, so
the "Change" control is greyed out until the year has passed (computed client-
side by usernameChangeEligibility; the RPC is still the real enforcement point).

Props:
  open              — boolean
  onClose           — () => void
  profile           — the caller's profiles row (username, display_name, username_source, ...)
  linguisticProfile — the caller's user_linguistic_profiles row (preferred_language)
  onSaved           — () => Promise<void>  (App reloads profile + language)
  onSignOut         — () => void
*/
export default function SettingsModal({ open, onClose, profile, linguisticProfile, onSaved, onSignOut }) {
  const [displayName, setDisplayNameState] = useState('');
  const [language, setLanguage] = useState('en');
  const [discoverUsername, setDiscoverUsername] = useState(true);
  const [discoverEmail, setDiscoverEmail] = useState(false);

  const [initial, setInitial] = useState(null); // snapshot to detect changes
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // username-change sub-panel
  const [ucOpen, setUcOpen] = useState(false);
  const [ucValue, setUcValue] = useState('');
  const [ucSaving, setUcSaving] = useState(false);
  const [ucError, setUcError] = useState('');

  const eligibility = useMemo(() => usernameChangeEligibility(profile), [profile]);

  // Hydrate on open.
  useEffect(() => {
    if (!open) return;
    setError(''); setUcOpen(false); setUcValue(''); setUcError('');
    const dn = profile?.display_name || '';
    const lang = linguisticProfile?.preferred_language || 'en';
    setDisplayNameState(dn);
    setLanguage(lang);

    let cancelled = false;
    (async () => {
      const { data } = await getAccountSettings();
      if (cancelled) return;
      const du = data?.discoverable_by_username ?? true;
      const de = data?.discoverable_by_email ?? false;
      setDiscoverUsername(du);
      setDiscoverEmail(de);
      setInitial({ displayName: dn, language: lang, discoverUsername: du, discoverEmail: de });
    })();
    return () => { cancelled = true; };
  }, [open, profile, linguisticProfile]);

  if (!open) return null;

  const dirty = initial && (
    displayName.trim() !== initial.displayName ||
    language !== initial.language ||
    discoverUsername !== initial.discoverUsername ||
    discoverEmail !== initial.discoverEmail
  );

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true); setError('');
    try {
      if (displayName.trim() !== initial.displayName) {
        const { error } = await setDisplayName(displayName.trim());
        if (error) throw mapError(error, 'display name');
      }
      if (language !== initial.language) {
        const { error } = await setPreferredLanguage(language);
        if (error) throw mapError(error, 'language');
      }
      if (discoverUsername !== initial.discoverUsername || discoverEmail !== initial.discoverEmail) {
        const { error } = await updateDiscoverability({
          discoverable_by_username: discoverUsername,
          discoverable_by_email: discoverEmail,
        });
        if (error) throw mapError(error, 'discoverability');
      }
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setSaving(false);
    }
  }

  async function handleUsernameSave() {
    const next = ucValue.trim().toLowerCase();
    if (!next || ucSaving) return;
    if (!/^[a-z0-9_]{3,20}$/.test(next)) {
      setUcError('3–20 characters: lowercase letters, numbers, and underscores only.');
      return;
    }
    setUcSaving(true); setUcError('');
    const { error } = await changeUsername(next);
    setUcSaving(false);
    if (error) {
      const msg = error.message || '';
      if (msg.includes('unavailable')) setUcError("That username's taken or reserved. Try another.");
      else if (msg.includes('same as current')) setUcError("That's already your username.");
      else if (msg.includes('once per 365') || msg.includes('365 days')) setUcError('You can only change your username once a year.');
      else if (msg.includes('invalid characters') || msg.includes('length must be')) setUcError('3–20 characters: lowercase letters, numbers, and underscores only.');
      else setUcError(msg || 'Could not change username. Try again.');
      return;
    }
    setUcOpen(false); setUcValue('');
    await onSaved?.();
  }

  const availableOnLabel = eligibility.availableOn
    ? eligibility.availableOn.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex md:items-center md:justify-center">
      <div className="bg-white w-full md:max-w-md md:rounded-2xl md:shadow-2xl flex flex-col h-full md:h-auto md:max-h-[88vh]">
        {/* header */}
        <header className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1" title="Cancel">
            <X size={16} strokeWidth={2.2} />
            Cancel
          </button>
          <h2 className="font-semibold flex items-center gap-1.5">
            <Settings size={16} strokeWidth={2.2} className="text-violet-600" />
            Settings
          </h2>
          <button
            disabled={!dirty || saving}
            onClick={handleSave}
            className="text-sm font-medium text-violet-600 disabled:text-slate-300 flex items-center gap-1"
          >
            <Check size={16} strokeWidth={2.4} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>

        <div className="p-4 overflow-y-auto">
          {/* ── Profile ── */}
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-3">
            <User size={14} strokeWidth={2.2} /> Profile
          </p>

          {/* username (display + gated change) */}
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div className="min-w-0 flex items-baseline gap-2">
              <span className="flex items-center gap-1 text-xs font-medium text-slate-500 shrink-0">
                <AtSign size={14} strokeWidth={2.2} /> Username
              </span>
              <span className="text-sm text-slate-800 break-all">@{profile?.username}</span>
            </div>
            <button
              onClick={() => eligibility.eligible && setUcOpen(true)}
              disabled={!eligibility.eligible || ucOpen}
              className="text-[13px] shrink-0 text-violet-600 disabled:text-slate-300"
              title={eligibility.eligible ? 'Change username' : (availableOnLabel ? `Available ${availableOnLabel}` : 'Not yet available')}
            >
              Change
            </button>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {eligibility.eligible
              ? 'You can change this once a year.'
              : `Usernames change once a year. Available ${availableOnLabel}.`}
          </p>

          {ucOpen && (
            <div className="mt-2.5">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">@</span>
                <input
                  value={ucValue}
                  onChange={(e) => setUcValue(e.target.value)}
                  placeholder="new_username"
                  autoFocus
                  className="w-full rounded-xl border border-slate-300 pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>
              {ucError && (
                <p className="text-[11px] text-rose-500 mt-1.5 flex items-center gap-1">
                  <AlertCircle size={13} strokeWidth={2.2} /> {ucError}
                </p>
              )}
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleUsernameSave}
                  disabled={ucSaving}
                  className="bg-violet-600 text-white text-xs font-medium px-3.5 py-1.5 rounded-lg disabled:bg-slate-300"
                >
                  {ucSaving ? 'Saving…' : 'Save username'}
                </button>
                <button
                  onClick={() => { setUcOpen(false); setUcValue(''); setUcError(''); }}
                  className="border border-slate-300 text-slate-500 text-xs px-3 py-1.5 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* display name (inline with label) */}
          <div className="border-t border-slate-100 mt-4 pt-4">
            <div className="flex items-center gap-2.5 flex-wrap">
              <label className="flex items-center gap-1 text-xs font-medium text-slate-500 shrink-0">
                <User size={14} strokeWidth={2.2} /> Display name
              </label>
              <input
                value={displayName}
                onChange={(e) => setDisplayNameState(e.target.value)}
                maxLength={50}
                className="flex-1 min-w-[150px] rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">The name other people see.</p>
          </div>

          {/* language (inline with label) */}
          <div className="border-t border-slate-100 mt-4 pt-4">
            <div className="flex items-center gap-2.5 flex-wrap">
              <label className="flex items-center gap-1 text-xs font-medium text-slate-500 shrink-0">
                <Languages size={14} strokeWidth={2.2} /> Language
              </label>
              <div className="relative flex-1 min-w-[150px]">
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full appearance-none rounded-xl border border-slate-300 pl-3 pr-9 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
                <ChevronDown size={16} strokeWidth={2.2} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">
              Messages you receive are translated into this language. Changing it only affects new messages.
            </p>
          </div>

          {/* ── Discoverability ── */}
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 mt-5 pt-4 border-t border-slate-100 mb-2.5">
            <Eye size={14} strokeWidth={2.2} /> Discoverability
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] text-slate-800 shrink-0">Let people find me by</span>
            <label className="inline-flex items-center gap-1.5 border border-slate-200 rounded-lg px-2.5 py-1.5 cursor-pointer">
              <input type="checkbox" checked={discoverUsername} onChange={(e) => setDiscoverUsername(e.target.checked)} className="w-[15px] h-[15px] accent-violet-600" />
              <span className="text-[13px] text-slate-800">Username</span>
            </label>
            <label className="inline-flex items-center gap-1.5 border border-slate-200 rounded-lg px-2.5 py-1.5 cursor-pointer">
              <input type="checkbox" checked={discoverEmail} onChange={(e) => setDiscoverEmail(e.target.checked)} className="w-[15px] h-[15px] accent-violet-600" />
              <span className="text-[13px] text-slate-800">Email</span>
            </label>
          </div>

          {error && <p className="text-xs text-rose-500 mt-4 flex items-center gap-1"><AlertCircle size={14} strokeWidth={2.2} /> {error}</p>}
        </div>

        {/* sign out (relocated from the app bar) */}
        <button
          onClick={onSignOut}
          className="flex items-center gap-2 w-full border-t border-slate-200 px-4 py-3.5 text-sm text-slate-600 hover:bg-slate-50 text-left"
        >
          <LogOut size={18} strokeWidth={2.2} />
          Sign out
        </button>
      </div>
    </div>
  );
}

// change_username / set_* RPC errors → { message } for the catch above.
function mapError(error, field) {
  const msg = error?.message || '';
  if (msg.includes('exceeds 50') || msg.includes('cannot be empty')) return new Error('Display name must be 1–50 characters.');
  if (msg.includes('invalid control characters')) return new Error('Display name contains characters that aren’t allowed.');
  return new Error(msg || `Could not update ${field}. Try again.`);
}
