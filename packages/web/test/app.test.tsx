import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { useLayoutEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../src/pages/dashboard.tsx', () => ({
  Dashboard: () => <div data-testid="page-dashboard" />,
}));
vi.mock('../src/pages/project.tsx', () => ({
  Project: () => <div data-testid="page-project" />,
}));
vi.mock('../src/pages/task-detail.tsx', () => ({
  TaskDetail: () => <div data-testid="page-task-detail" />,
}));
vi.mock('../src/pages/terminal.tsx', () => ({
  Terminal: () => <div data-testid="page-terminal" />,
}));
vi.mock('../src/components/pending-restart-banner.tsx', () => ({
  PendingRestartBanner: () => null,
}));

import { App } from '../src/app.tsx';
import { TOPBAR_ACTIONS_ID, TopbarActions } from '../src/components/topbar-actions.tsx';

beforeEach(() => {
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('App shell layout', () => {
  it('renders a compact top navigation with a brand-only Home link', () => {
    const { container } = render(<App />);

    const homeLink = screen.getByRole('link', { name: 'baxian' });
    expect(homeLink.getAttribute('href')).toBe('/');
    expect(homeLink.textContent).toContain('baxian');
    expect(homeLink.getAttribute('aria-label')).toBeNull();

    const dot = homeLink.querySelector('span[aria-hidden]');
    expect(dot).toBeTruthy();
    expect(dot!.className).toContain('bg-accent');
    expect(dot!.className).toContain('h-2.5');
    expect(dot!.className).toContain('w-2.5');
    expect(dot!.className).toContain('rounded-full');
    expect(dot!.className).not.toContain('rounded-sm');

    const nav = container.querySelector('nav')!;
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Tasks' })).toBeNull();
    expect(container.querySelector('a[href="/tasks"]')).toBeNull();
    expect(nav.querySelector('button[aria-label^="切换为 Logo"]')).toBeNull();

    const actions = nav.querySelector(`#${TOPBAR_ACTIONS_ID}`);
    expect(actions).toBeTruthy();
    expect(actions!.className).toContain('ml-auto');
    expect(actions!.className).toContain('justify-end');

    const navLinks = nav.querySelectorAll('a');
    expect(navLinks.length).toBe(1);
    expect(navLinks[0]).toBe(homeLink);
  });

  it('still routes "/" to the Dashboard page even though its nav link was removed', () => {
    render(<App />);
    expect(screen.getByTestId('page-dashboard')).toBeTruthy();
  });

  it('routes /project/:id/task/:taskId to the TaskDetail page', () => {
    window.history.pushState({}, '', '/project/baxian/task/task-172');
    render(<App />);
    expect(screen.getByTestId('page-task-detail')).toBeTruthy();
    expect(screen.queryByTestId('page-project')).toBeNull();
  });

  it('uses dynamic viewport sizing and aligned nav/main padding', () => {
    const { container } = render(<App />);

    const nav = container.querySelector('nav');
    const main = container.querySelector('main');
    expect(nav).toBeTruthy();
    expect(main).toBeTruthy();

    const shell = container.querySelector('nav')!.parentElement!;
    expect(shell.className).toContain('h-dvh');
    expect(shell.className).not.toContain('h-screen');

    const getHorizontalPadding = (el: HTMLElement) => {
      const padding = Array.from(el.classList).filter((c) => /(?:^|:)px-/.test(c)).sort();
      expect(padding.length).toBeGreaterThan(0);
      return padding;
    };

    expect(getHorizontalPadding(main!)).toEqual(getHorizontalPadding(nav!));
    expect(main!.classList.contains('py-6')).toBe(true);
    expect(main!.classList.contains('p-6')).toBe(false);
  });

  it('renders the bottom BrandToggle on non-terminal routes and keeps its toggle behavior', () => {
    const { container } = render(<App />);

    const footer = container.querySelector('footer');
    expect(footer).toBeTruthy();
    expect(footer!.className).toContain('mt-auto');
    expect(footer!.className).toContain('justify-center');
    expect(footer!.className).toContain('pt-24');
    expect(footer!.className).toContain('pb-4');

    const toggleBtn = footer!.querySelector('button[aria-label^="切换为 Logo"]') as HTMLButtonElement | null;
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn!.getAttribute('aria-label')).toBe('切换为 Logo 文字');

    expect(footer!.querySelector('img')?.getAttribute('src')).toBe('/baxian-logo.png');

    fireEvent.click(toggleBtn!);
    expect(footer!.querySelector('img')).toBeNull();
    expect(footer!.textContent).toContain('baxian');
    expect(toggleBtn!.getAttribute('aria-label')).toBe('切换为 Logo 图标');

    fireEvent.click(toggleBtn!);
    expect(footer!.querySelector('img')?.getAttribute('src')).toBe('/baxian-logo.png');

    cleanup();
    window.history.pushState({}, '', '/project/demo');
    const projectRoute = render(<App />);
    const projectFooter = projectRoute.container.querySelector('footer');
    expect(projectFooter).toBeTruthy();
    expect(projectFooter!.querySelector('button[aria-label^="切换为 Logo"]')).toBeTruthy();
  });

  it('hides the bottom BrandToggle footer on /terminal/:agentId so the full-height terminal pane is not pushed up by the footer', () => {
    window.history.pushState({}, '', '/terminal/dev-1');
    const { container } = render(<App />);

    expect(container.querySelector('footer')).toBeNull();
    expect(screen.getByTestId('page-terminal')).toBeTruthy();
  });
});

describe('TopbarActions', () => {
  it('portals into an existing topbar container before layout effects run', () => {
    document.body.innerHTML = `<div id="${TOPBAR_ACTIONS_ID}"></div>`;
    const layoutSnapshots: string[] = [];

    function LayoutProbe() {
      useLayoutEffect(() => {
        layoutSnapshots.push(document.getElementById(TOPBAR_ACTIONS_ID)?.textContent ?? '');
      }, []);
      return null;
    }

    render(
      <>
        <TopbarActions><button type="button">first-pass action</button></TopbarActions>
        <LayoutProbe />
      </>,
    );

    expect(layoutSnapshots).toEqual(['first-pass action']);
    expect(screen.getByRole('button', { name: 'first-pass action' })).toBeTruthy();
  });

  it('falls back after mount when the topbar container is created in the same React commit', async () => {
    render(
      <>
        <div id={TOPBAR_ACTIONS_ID} />
        <TopbarActions><button type="button">same-commit action</button></TopbarActions>
      </>,
    );

    expect(await screen.findByRole('button', { name: 'same-commit action' })).toBeTruthy();
  });
});

describe('index.html', () => {
  const indexHtml = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
    'utf8',
  );

  it('declares the brand PNG for browser and iOS icons', () => {
    expect(indexHtml).toMatch(
      /<link\s+rel="icon"\s+type="image\/png"\s+href="\/baxian-logo\.png"\s*\/?>/,
    );
    expect(indexHtml).toMatch(
      /<link\s+rel="apple-touch-icon"\s+href="\/baxian-logo\.png"\s*\/?>/,
    );
  });
});
