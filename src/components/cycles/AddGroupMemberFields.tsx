import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface NewGroupMember {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

interface Props {
  disabled?: boolean;
  onAdd: (member: NewGroupMember) => void;
}

// A simple email shape check (same intent as AddPlayerForm; not imported to keep this
// dependency-light + role-isolation clean — this lives in neutral components/cycles).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal inline form to capture a NEW group member (first name required; last name,
 * email, phone optional). Emits the details upward — the actual guest_player row is
 * created server-side (token-gated) by the caller, never written from here.
 */
export function AddGroupMemberFields({ disabled, onAdd }: Props) {
  const { t } = useTranslation('cycles');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setFirstName(''); setLastName(''); setEmail(''); setPhone(''); setError(null); };

  const submit = () => {
    const fn = firstName.trim();
    if (!fn) { setError(t('rebookGroup.addFirstNameRequired', 'Vul minstens een voornaam in.')); return; }
    const em = email.trim();
    if (em && !EMAIL_RE.test(em)) { setError(t('rebookGroup.addEmailInvalid', 'Vul een geldig e-mailadres in.')); return; }
    onAdd({ firstName: fn, lastName: lastName.trim() || undefined, email: em || undefined, phone: phone.trim() || undefined });
    reset();
  };

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="ngm-first" className="text-xs">{t('rebookGroup.firstName', 'Voornaam')}</Label>
          <Input id="ngm-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={disabled} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ngm-last" className="text-xs">{t('rebookGroup.lastName', 'Achternaam')}</Label>
          <Input id="ngm-last" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={disabled} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ngm-email" className="text-xs">{t('rebookGroup.email', 'E-mail')}</Label>
          <Input id="ngm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={disabled} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ngm-phone" className="text-xs">{t('rebookGroup.phone', 'Telefoon')}</Label>
          <Input id="ngm-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={disabled} />
        </div>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <Button type="button" size="sm" variant="outline" onClick={submit} disabled={disabled}>
        <UserPlus className="h-4 w-4 mr-1" /> {t('rebookGroup.addToGroup', 'Toevoegen aan groep')}
      </Button>
    </div>
  );
}
