import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandToggle } from '../../src/components/brand-toggle.tsx';

describe('BrandToggle', () => {
  it('defaults to the logo image with the switch-to-text aria-label', () => {
    render(<BrandToggle />);

    const img = screen.getByRole('img', { name: 'baxian' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/baxian-logo.png');
    expect(img.getAttribute('height')).toBe('24');

    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to logo text');
  });

  it('renders the logo at fixed h-6 with width auto so non-square brand assets keep their aspect ratio, and declares intrinsic width=20 (height=24 * 213/256) so the browser reserves the right box pre-load and avoids CLS', () => {
    render(<BrandToggle />);
    const img = screen.getByRole('img', { name: 'baxian' }) as HTMLImageElement;
    expect(img.className).toContain('h-6');
    expect(img.className).toContain('w-auto');
    expect(img.className).not.toContain('w-6');
    expect(img.getAttribute('width')).toBe('20');
  });

  it('clicking swaps the logo for the text variant and updates the aria-label', () => {
    render(<BrandToggle />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('baxian')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to logo icon');
  });

  it('button reserves only ~60px min-width so the brand area stays compact', () => {
    render(<BrandToggle />);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('min-w-[60px]');
    expect(btn.className).not.toContain('min-w-[88px]');
  });

  it('text variant wraps the label in a 24px flex box with collapsed line-height so its center matches the icon', () => {
    render(<BrandToggle />);
    fireEvent.click(screen.getByRole('button'));

    const label = screen.getByText('baxian');
    expect(label.className).toContain('inline-flex');
    expect(label.className).toContain('items-center');
    expect(label.className).toContain('h-6');
    expect(label.className).toContain('leading-none');
  });

  it('button centers its child so icon (narrow) and text (wider) variants share the same horizontal centre', () => {
    render(<BrandToggle />);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('justify-center');
    expect(btn.className).not.toContain('justify-start');

    const iconChild = btn.firstElementChild as HTMLElement;
    expect(iconChild.tagName).toBe('IMG');

    fireEvent.click(btn);
    const textChild = btn.firstElementChild as HTMLElement;
    expect(textChild.tagName).toBe('SPAN');
    expect(textChild.textContent).toBe('baxian');
  });

  it('clicking again restores the logo image', () => {
    render(<BrandToggle />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(screen.getByRole('img', { name: 'baxian' }).getAttribute('src')).toBe('/baxian-logo.png');
    expect(btn.getAttribute('aria-label')).toBe('Switch to logo text');
  });
});
