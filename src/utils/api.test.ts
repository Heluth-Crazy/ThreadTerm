import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fileAccessMode before importing api
vi.mock('./fileAccessMode', () => ({
  getStoredFileAccessMode: vi.fn(() => ''),
}));

import { api, authenticatedFetch } from './api';
import { getStoredFileAccessMode } from './fileAccessMode';

const mockedGetStoredFileAccessMode = vi.mocked(getStoredFileAccessMode);

describe('api.js', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockedGetStoredFileAccessMode.mockReturnValue('Auto');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- authenticatedFetch / fetchWrapper ---

  describe('authenticatedFetch (fetchWrapper)', () => {
    it('should call fetch with Content-Type json header by default', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await authenticatedFetch('/api/test');

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      });
    });

    it('should not set Content-Type when body is FormData', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      const formData = new FormData();
      formData.append('file', 'data');

      await authenticatedFetch('/api/upload', { body: formData });

      const calledHeaders = mockFetch.mock.calls[0][1].headers;
      expect(calledHeaders['Content-Type']).toBeUndefined();
    });

    it('should include file access mode header when set', async () => {
      mockedGetStoredFileAccessMode.mockReturnValue('Direct');
      mockFetch.mockResolvedValue(new Response('ok'));

      await authenticatedFetch('/api/test');

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        headers: expect.objectContaining({
          'x-openwork-file-access-mode': 'Direct',
        }),
      });
    });

    it('should merge custom headers', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await authenticatedFetch('/api/test', {
        headers: { 'X-Custom': 'value' },
      });

      const calledHeaders = mockFetch.mock.calls[0][1].headers;
      expect(calledHeaders['X-Custom']).toBe('value');
      expect(calledHeaders['Content-Type']).toBe('application/json');
    });

    it('should propagate network errors', async () => {
      mockFetch.mockRejectedValue(new TypeError('Network error'));
      await expect(authenticatedFetch('/api/test')).rejects.toThrow('Network error');
    });
  });

  // --- api.auth ---

  describe('api.auth', () => {
    it('auth.status should call GET /api/auth/status', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      await api.auth.status();
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/status');
    });

    it('auth.login should POST credentials', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      await api.auth.login('user1', 'pass1');

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'user1', password: 'pass1' }),
      });
    });

    it('auth.register should POST credentials', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      await api.auth.register('newUser', 'newPass');

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'newUser', password: 'newPass' }),
      });
    });
  });

  // --- api resource endpoints ---

  describe('api resource endpoints', () => {
    it('api.projects should fetch /api/projects', async () => {
      mockFetch.mockResolvedValue(new Response('[]'));
      await api.projects();
      expect(mockFetch).toHaveBeenCalledWith('/api/projects', expect.any(Object));
    });

    it('api.sessions should encode project name and include pagination', async () => {
      mockFetch.mockResolvedValue(new Response('[]'));
      await api.sessions('my project', 10, 5);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/api/projects/my%20project/sessions');
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=5');
    });

    it('api.sessionMessages should route to codex endpoint for codex provider', async () => {
      mockFetch.mockResolvedValue(new Response('[]'));
      await api.sessionMessages('proj', 'sess-1', null, 0, 'codex');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/api/codex/sessions/sess-1/messages');
    });

    it('api.sessionMessages should route to claude endpoint by default', async () => {
      mockFetch.mockResolvedValue(new Response('[]'));
      await api.sessionMessages('proj', 'sess-1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/api/projects/proj/sessions/sess-1/messages');
    });

    it('api.deleteSession should send DELETE with encoded params', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await api.deleteSession('proj/special', 'sess-1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(encodeURIComponent('proj/special'));
      const opts = mockFetch.mock.calls[0][1];
      expect(opts.method).toBe('DELETE');
    });

    it('api.deleteProject with force should append query param', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await api.deleteProject('myproj', true);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('?force=true');
    });

    it('api.createProject should POST the path', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await api.createProject('/home/user/project');

      const opts = mockFetch.mock.calls[0][1];
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ path: '/home/user/project' });
    });
  });

  // --- api.get ---

  describe('api.get', () => {
    it('should fetch /api + endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await api.get('/custom/endpoint');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('/api/custom/endpoint');
    });
  });

  // --- api.skills ---

  describe('api.skills', () => {
    it('skills.list should GET /api/skills', async () => {
      mockFetch.mockResolvedValue(new Response('[]'));
      await api.skills.list();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('/api/skills');
    });

    it('skills.delete should send DELETE with encoded skillId', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      await api.skills.delete('skill/with spaces');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(encodeURIComponent('skill/with spaces'));
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  // --- api.transcribe ---

  describe('api.transcribe', () => {
    it('should POST FormData with empty headers (let browser set Content-Type)', async () => {
      mockFetch.mockResolvedValue(new Response('ok'));
      const fd = new FormData();
      await api.transcribe(fd);

      const opts = mockFetch.mock.calls[0][1];
      expect(opts.method).toBe('POST');
      expect(opts.body).toBe(fd);
    });
  });
});
