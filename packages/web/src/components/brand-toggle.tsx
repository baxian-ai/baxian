import { useState } from 'react';

export function BrandToggle() {
  const [asText, setAsText] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setAsText((v) => !v)}
      aria-label={asText ? '切换为 Logo 图标' : '切换为 Logo 文字'}
      className="flex h-7 min-w-[60px] shrink-0 items-center justify-center font-display text-[16px] font-semibold tracking-tight text-og-1000"
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
