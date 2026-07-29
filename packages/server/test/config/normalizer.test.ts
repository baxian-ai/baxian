import { describe, it, expect } from 'vitest';
import { normalizeConfig } from '../../src/config/normalizer.js';

describe('normalizeConfig', () => {
  describe('plural → singular', () => {
    it('renames top-level "projects" to "project"', () => {
      const result = normalizeConfig({ projects: [{ id: 'p1' }] });
      expect(result).toHaveProperty('project');
      expect(result).not.toHaveProperty('projects');
      expect(result.project).toEqual([{ id: 'p1' }]);
    });

    it('singular wins when both "project" and "projects" exist', () => {
      const result = normalizeConfig({
        project: [{ id: 'a' }],
        projects: [{ id: 'b' }],
      });
      expect(result.project).toEqual([{ id: 'a' }]);
    });

    it('singular wins regardless of declaration order (plural first)', () => {
      const result = normalizeConfig({
        projects: [{ id: 'b' }],
        project: [{ id: 'a' }],
      });
      expect(result.project).toEqual([{ id: 'a' }]);
    });

    it('renames "agents" to "agent" inside project items', () => {
      const result = normalizeConfig({
        project: [{ id: 'p1', agents: [[{ id: 'a1' }]] }],
      });
      const proj = (result.project as Record<string, unknown>[])[0];
      expect(proj).toHaveProperty('agent');
      expect(proj).not.toHaveProperty('agents');
    });

  });

  describe('case normalization', () => {
    it('lowercases top-level keys', () => {
      const result = normalizeConfig({
        Review: { rounds: 5 },
        Server: { port: 8080 },
      });
      expect(result).toHaveProperty('review');
      expect(result).toHaveProperty('server');
    });

    it.each(['specApproval', 'specapproval', 'SpecApproval'])(
      'restores canonical camelCase for project key %s',
      (key) => {
        const result = normalizeConfig({
          project: [{ id: 'p', repo: 'u/r', [key]: 'human' }],
        });
        const proj = (result.project as Record<string, unknown>[])[0];
        expect(proj.specApproval).toBe('human');
        expect(proj).not.toHaveProperty('specapproval');
      },
    );

    it('restores canonical camelCase for gitCli', () => {
      const result = normalizeConfig({
        project: [{ id: 'p', repo: 'x', gitCli: { tool: 'glab' } }],
      });
      const proj = (result.project as Record<string, unknown>[])[0];
      expect(proj.gitCli).toEqual({ tool: 'glab' });
      expect(proj).not.toHaveProperty('gitcli');
    });

  });

  describe('passthrough', () => {
    it('passes valid config through unchanged', () => {
      const input = {
        review: { rounds: 10 },
        server: { port: 3000 },
        project: [
          {
            id: 'proj',
            repo: 'user/repo',
            merge: 'auto',
            agent: [[{ id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' }]],
          },
        ],
      };
      expect(normalizeConfig(input)).toEqual(input);
    });
  });

  describe('agent.yolo field passthrough', () => {
    it('passes yolo: true through unchanged', () => {
      const result = normalizeConfig({
        project: [{
          id: 'p', repo: 'u/r',
          agent: [[{ id: 'd', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true }]],
        }],
      });
      const proj = (result.project as Record<string, unknown>[])[0];
      const team = (proj.agent as Record<string, unknown>[][])[0];
      expect(team[0].yolo).toBe(true);
    });

    it('passes yolo: false through unchanged', () => {
      const result = normalizeConfig({
        project: [{
          id: 'p', repo: 'u/r',
          agent: [[{ id: 'd', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: false }]],
        }],
      });
      const proj = (result.project as Record<string, unknown>[])[0];
      const team = (proj.agent as Record<string, unknown>[][])[0];
      expect(team[0].yolo).toBe(false);
    });

    it('leaves yolo undefined for legacy configs', () => {
      const result = normalizeConfig({
        project: [{
          id: 'p', repo: 'u/r',
          agent: [[{ id: 'd', runtime: 'claude-code', role: 'dev', mode: 'local' }]],
        }],
      });
      const proj = (result.project as Record<string, unknown>[])[0];
      const team = (proj.agent as Record<string, unknown>[][])[0];
      expect(team[0].yolo).toBeUndefined();
    });
  });
});
