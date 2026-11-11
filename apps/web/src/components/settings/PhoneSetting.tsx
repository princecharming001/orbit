/**
 * Settings, Profile: the phone number Orbit texts when the first import is done (plan 40), and the two ways to hear
 * about it. The number saves when it is whole and the field is left; removing every digit removes it.
 */
import { countryForTimeZone, type User } from '@orbit/core';
import { useEffect, useState } from 'react';
import { type Contact, loadContact, saveContact } from '../../engine/notify';
import { Label, Switch } from '../../ui';
import { PhoneField, type PhoneValue } from '../PhoneField';

export function PhoneSetting({ user }: { user: Pick<User, 'id' | 'email' | 'timezone'> }) {
  const [contact, setContact] = useState<Contact>();
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void loadContact(user).then((c) => live && setContact(c));
    return () => {
      live = false;
    };
  }, [user.id]);

  const save = async (patch: Parameters<typeof saveContact>[1]) => {
    setState('saving');
    setError(undefined);
    const r = await saveContact(user, patch);
    if (r.ok) {
      setContact(r.contact);
      setState('saved');
    } else {
      setError(r.message);
      setState('error');
    }
  };

  // a whole new number saves when the field is left; an emptied field removes the saved one
  const onLeave = (v: PhoneValue) => {
    if (!contact) return;
    if (v.valid && v.e164 && v.e164 !== contact.phone)
      void save({ phone: v.e164, country: v.country, smsOn: true });
    else if (v.empty && contact.phone) void save({ phone: null, smsOn: false });
  };

  const hasPhone = !!contact?.phone;
  return (
    <div className="@[40rem]:col-span-2" data-testid="settings-phone">
      <Label htmlFor="profile-phone">Phone</Label>
      {contact ? (
        <>
          <div className="max-w-sm">
            <PhoneField
              id="profile-phone"
              label="Phone"
              variant="line"
              value={{ e164: contact.phone, country: contact.country }}
              defaultCountry={countryForTimeZone(user.timezone) ?? 'US'}
              onBlur={onLeave}
            />
          </div>
          <div className="mt-3 flex flex-col gap-2 text-[13px]">
            <label className="flex items-center gap-2.5">
              <Switch
                checked={contact.emailOn}
                label="Email me when Orbit is ready"
                onChange={(on) => void save({ emailOn: on })}
                data-testid="settings-phone-email-on"
              />
              <span className="text-ink-2">
                Email me when Orbit is ready{contact.email ? ` at ${contact.email}` : ''}
              </span>
            </label>
            <label className="flex items-center gap-2.5">
              <Switch
                checked={hasPhone && contact.smsOn}
                disabled={!hasPhone}
                label="Text me when Orbit is ready"
                onChange={(on) => void save({ smsOn: on })}
                data-testid="settings-phone-sms-on"
              />
              <span className={hasPhone ? 'text-ink-2' : 'text-ink-3'}>
                Text me when Orbit is ready
                {hasPhone ? '' : <span className="text-ink-3"> · add a number above first</span>}
              </span>
            </label>
          </div>
          <p
            className="mt-2 min-h-[18px] text-[12px] text-ink-3"
            aria-live="polite"
            data-testid="settings-phone-state"
          >
            {state === 'saving' ? (
              'Saving…'
            ) : state === 'saved' ? (
              'Saved'
            ) : state === 'error' ? (
              <span className="text-bad">{error}</span>
            ) : null}
          </p>
        </>
      ) : (
        <div className="h-10" aria-busy />
      )}
    </div>
  );
}
