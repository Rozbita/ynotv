import { describe, it, expect } from 'vitest';
import { parseBulkStalkerInput, normalizeMacAddress } from '../stalkerBulkParser';

describe('stalkerBulkParser', () => {
  it('normalizes MAC addresses with hyphens and lowercase characters', () => {
    expect(normalizeMacAddress('00-1a-79-aa-bb-cc')).toBe('00:1A:79:AA:BB:CC');
    expect(normalizeMacAddress('11:22:33:44:55:66')).toBe('11:22:33:44:55:66');
  });

  it('correctly parses multiple stalker portals with primary and backup MACs', () => {
    const input = `
http://vod.url1.com/c/
11:22:33:44:55:66
22:33:44:55:66:77
33:44:55:66:77:88
http://tv.url2.com:80/c/
11:22:33:44:55:66
22:33:44:55:66:77
33:44:55:66:77:88
44:55:66:77:88:99
http://111.222.333.444/c/
11:22:33:44:55:66
22:33:44:55:66:77
33:44:55:66:77:88
`;

    const result = parseBulkStalkerInput(input);
    expect(result).toHaveLength(3);

    // Entry 1
    expect(result[0].url).toBe('http://vod.url1.com/c/');
    expect(result[0].name).toBe('vod.url1.com');
    expect(result[0].mac).toBe('11:22:33:44:55:66');
    expect(result[0].backupMacs).toEqual(['22:33:44:55:66:77', '33:44:55:66:77:88']);

    // Entry 2
    expect(result[1].url).toBe('http://tv.url2.com:80/c/');
    expect(result[1].name).toBe('tv.url2.com');
    expect(result[1].mac).toBe('11:22:33:44:55:66');
    expect(result[1].backupMacs).toEqual([
      '22:33:44:55:66:77',
      '33:44:55:66:77:88',
      '44:55:66:77:88:99',
    ]);

    // Entry 3
    expect(result[2].url).toBe('http://111.222.333.444/c/');
    expect(result[2].name).toBe('111.222.333.444');
    expect(result[2].mac).toBe('11:22:33:44:55:66');
    expect(result[2].backupMacs).toEqual(['22:33:44:55:66:77', '33:44:55:66:77:88']);
  });

  it('supports custom comments as portal names', () => {
    const input = `
# My Premium Portal
http://vod.example.com/c/
00:1A:79:11:22:33
00:1A:79:44:55:66
`;

    const result = parseBulkStalkerInput(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('My Premium Portal');
    expect(result[0].url).toBe('http://vod.example.com/c/');
    expect(result[0].mac).toBe('00:1A:79:11:22:33');
    expect(result[0].backupMacs).toEqual(['00:1A:79:44:55:66']);
  });

  it('automatically adds http scheme if omitted from URL', () => {
    const input = `
vod.myservice.com:8080/c/
00:11:22:33:44:55
`;

    const result = parseBulkStalkerInput(input);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('http://vod.myservice.com:8080/c/');
    expect(result[0].mac).toBe('00:11:22:33:44:55');
    expect(result[0].backupMacs).toEqual([]);
  });

  it('normalizes MAC addresses with hyphens, dots, Cisco format, and compact hex', () => {
    expect(normalizeMacAddress('00-1a-79-aa-bb-cc')).toBe('00:1A:79:AA:BB:CC');
    expect(normalizeMacAddress('11:22:33:44:55:66')).toBe('11:22:33:44:55:66');
    expect(normalizeMacAddress('00.1a.79.aa.bb.cc')).toBe('00:1A:79:AA:BB:CC');
    expect(normalizeMacAddress('001a.79aa.bbcc')).toBe('00:1A:79:AA:BB:CC');
    expect(normalizeMacAddress('001A79AABBCC')).toBe('00:1A:79:AA:BB:CC');
  });

  it('correctly handles comments placed between URL and MAC', () => {
    const input = `
http://vod.url1.com/c/
# Notes: VIP server
00:1A:79:11:22:33
00:1A:79:22:33:44
`;
    const result = parseBulkStalkerInput(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Notes: VIP server');
    expect(result[0].url).toBe('http://vod.url1.com/c/');
    expect(result[0].mac).toBe('00:1A:79:11:22:33');
    expect(result[0].backupMacs).toEqual(['00:1A:79:22:33:44']);
  });

  it('correctly parses bare hostnames without scheme or trailing slash', () => {
    const input = `
vod.service.net
00:1A:79:11:22:33
`;
    const result = parseBulkStalkerInput(input);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('http://vod.service.net');
    expect(result[0].mac).toBe('00:1A:79:11:22:33');
  });

  it('returns empty array when input contains no valid URLs or MACs', () => {
    expect(parseBulkStalkerInput('')).toEqual([]);
    expect(parseBulkStalkerInput('just some random text without urls')).toEqual([]);
    expect(parseBulkStalkerInput('http://onlyurl.com/c/')).toEqual([]); // No MAC address provided
  });
});
