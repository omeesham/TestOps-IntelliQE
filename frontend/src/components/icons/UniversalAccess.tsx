/**
 * Universal access symbol — a person with outstretched arms inside a circle.
 *
 * This is the conventional icon for digital accessibility (used by Apple,
 * Android, Windows, Material and Font Awesome for accessibility settings).
 * The wheelchair pictogram is the International Symbol of Access for physical
 * spaces and reads as "mobility" rather than "accessibility of software".
 *
 * Drawn on Lucide's 24px grid with a 2px round stroke so it sits next to the
 * other Lucide icons without looking foreign. Accepts the same props.
 */
import type { SVGProps } from 'react';

export default function UniversalAccess({ className = '', strokeWidth = 2, ...rest }: SVGProps<SVGSVGElement> & { strokeWidth?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="7.25" r="1.25" fill="currentColor" stroke="none" />
      <path d="M7.5 10.25c1.5.45 3 .7 4.5.7s3-.25 4.5-.7" />
      <path d="M12 11v3.25" />
      <path d="M12 14.25 10.25 18.5" />
      <path d="M12 14.25 13.75 18.5" />
    </svg>
  );
}
