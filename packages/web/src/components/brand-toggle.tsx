import { useState } from 'react';
import { useT } from '../i18n/index.tsx';

export function BrandToggle() {
  const t = useT();
  const [asText, setAsText] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setAsText((v) => !v)}
      aria-label={asText ? t.nav.toggleToIcon : t.nav.toggleToText}
      className="flex h-7 min-w-[60px] shrink-0 items-center justify-center font-display text-sm font-semibold tracking-tight text-og-1000"
    >
      {asText ? (
        <span className="inline-flex h-6 items-center leading-none">baxian</span>
      ) : (
        <img
          src="/baxian-logo.png"
          alt="baxian"
          width={20}
          height={24}
          className="block h-6 w-auto"
        />
      )}
    </button>
  );
}
