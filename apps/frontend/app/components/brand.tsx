import Link from 'next/link';

export function Brand() {
  return (
    <Link className="brand" href="/exchange/ABC" aria-label="Mini Exchange">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="23" height="23" fill="none">
          <path
            d="M5 22.5 11.5 9l4.5 9L20.5 9 27 22.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>
        Mini<span className="brand-light"> Exchange</span>
      </span>
    </Link>
  );
}
