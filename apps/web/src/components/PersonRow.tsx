import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, cx } from '../ui';
import { CompanyLogo } from './CompanyLogo';

/**
 * One row design for a person wherever Orbit lists them to act on (plan 23 §5): the company page, the plan and the
 * Chats view. Avatar, name (it opens them), title with the company's logo, one line of context, a badge, and at most
 * one button. Everything else the row could say belongs on their page.
 */
export function PersonRow({
  person,
  sub,
  line,
  badge,
  action,
  extra,
  className,
  testId = 'person-row',
}: {
  person: {
    id: string;
    displayName: string;
    photoUrl?: string;
    currentTitle?: string;
    currentOrganizationRaw?: string;
    currentOrganizationId?: string;
  };
  /** under the name; the title by default */
  sub?: ReactNode;
  /** the route in words, the time of the chat, what came back */
  line?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
  /** a disclosure or anything that opens under the row */
  extra?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const org = person.currentOrganizationRaw;
  return (
    <li className={cx('py-2.5', className)} data-testid={testId} data-person-id={person.id}>
      <div className="flex items-start gap-3">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to={`/people/${person.id}`}
              className="font-medium text-[14px] hover:underline truncate"
              data-testid="person-row-name"
            >
              {person.displayName}
            </Link>
            {badge}
          </div>
          <div className="text-[12.5px] text-ink-3 flex items-center gap-1.5 min-w-0">
            {org && <CompanyLogo name={org} orgId={person.currentOrganizationId} size={14} decorative />}
            <span className="truncate">{sub ?? person.currentTitle ?? org}</span>
          </div>
          {line && (
            <div className="text-[12.5px] text-ink-2 mt-0.5" data-testid="person-row-line">
              {line}
            </div>
          )}
        </div>
        {action && <div className="shrink-0 self-center">{action}</div>}
      </div>
      {extra}
    </li>
  );
}
