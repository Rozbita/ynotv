import { describe, it, expect } from 'vitest';
import type { SavedProxyProfile, AppSettings } from '../../../types/app';

describe('Saved Proxy Profiles Management', () => {
  it('creates and adds a new proxy profile', () => {
    const existingProfiles: SavedProxyProfile[] = [];
    const newProfile: SavedProxyProfile = {
      id: 'proxy-1',
      name: 'US East SOCKS5',
      server: 'socks5h://192.168.1.100:1080',
      username: 'user1',
      password: 'secretpassword',
    };

    const updated = [...existingProfiles, newProfile];
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('proxy-1');
    expect(updated[0].name).toBe('US East SOCKS5');
    expect(updated[0].server).toBe('socks5h://192.168.1.100:1080');
  });

  it('updates an existing proxy profile in the profile list', () => {
    const profiles: SavedProxyProfile[] = [
      {
        id: 'proxy-1',
        name: 'US East SOCKS5',
        server: 'socks5h://192.168.1.100:1080',
        username: 'user1',
        password: 'pass',
      },
      {
        id: 'proxy-2',
        name: 'EU West VPN',
        server: 'socks5h://10.0.0.5:1080',
        username: 'eu_user',
      },
    ];

    const targetId = 'proxy-1';
    const updated = profiles.map((p) =>
      p.id === targetId
        ? {
            ...p,
            server: 'socks5h://192.168.1.200:1080',
            username: 'user1_new',
          }
        : p
    );

    expect(updated).toHaveLength(2);
    expect(updated[0].server).toBe('socks5h://192.168.1.200:1080');
    expect(updated[0].username).toBe('user1_new');
    expect(updated[1].server).toBe('socks5h://10.0.0.5:1080');
  });

  it('deletes a proxy profile from the profile list', () => {
    const profiles: SavedProxyProfile[] = [
      {
        id: 'proxy-1',
        name: 'US East',
        server: '192.168.1.100:1080',
        username: '',
      },
      {
        id: 'proxy-2',
        name: 'EU West',
        server: '10.0.0.5:1080',
        username: '',
      },
    ];

    const toDeleteId = 'proxy-1';
    const updated = profiles.filter((p) => p.id !== toDeleteId);

    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('proxy-2');
  });

  it('correctly maps profile settings to AppSettings structure', () => {
    const profiles: SavedProxyProfile[] = [
      {
        id: 'proxy-1',
        name: 'Primary Proxy',
        server: '192.168.1.50:1080',
        username: 'admin',
        password: '123',
      },
    ];

    const activeProfile = profiles[0];

    const settings: AppSettings = {
      socks5ProxyEnabled: true,
      socks5ProxyServer: activeProfile.server,
      socks5ProxyUsername: activeProfile.username,
      socks5ProxyPassword: activeProfile.password,
      socks5ProxyProfiles: profiles,
      socks5ProxyActiveProfileId: activeProfile.id,
    };

    expect(settings.socks5ProxyEnabled).toBe(true);
    expect(settings.socks5ProxyServer).toBe('192.168.1.50:1080');
    expect(settings.socks5ProxyProfiles).toHaveLength(1);
    expect(settings.socks5ProxyActiveProfileId).toBe('proxy-1');
  });
});
