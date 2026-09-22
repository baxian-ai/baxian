import { enUS } from '../../src/i18n/en-us.ts';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandToggle } from '../../src/components/brand-toggle.tsx';

describe('BrandToggle', () => {
  it('defaults to the logo image with its intrinsic 20x24 box (avoids CLS) and the switch-to-text aria-label', () => {
    render(<BrandToggle />);

    const img = screen.getByRole('img', { name: 'baxian' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/baxian-logo.png');
    expect(img.getAttribute('width')).toBe('20');
    expect(img.getAttribute('height')).toBe('24');

    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(enUS.nav.toggleToText);
  });

  it('clicking swaps the logo for the text variant and updates the aria-label', () => {
    render(<BrandToggle />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('baxian')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(enUS.nav.toggleToIcon);
  });

  it('clicking again restores the logo image', () => {
    render(<BrandToggle />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(screen.getByRole('img', { name: 'baxian' }).getAttribute('src')).toBe('/baxian-logo.png');
    expect(btn.getAttribute('aria-label')).toBe(enUS.nav.toggleToText);
  });
});
