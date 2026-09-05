export interface ParsedStalkerPortal {
  id: string;
  name: string;
  url: string;
  mac: string;
  backupMacs: string[];
}

/**
 * Validates whether a string looks like a MAC address in colon, hyphen, dot,
 * Cisco 3-group, or 12-character compact hex format.
 */
export function isMacAddress(str: string): boolean {
  const trimmed = str.trim();
  return (
    /^([0-9A-Fa-f]{2}[:.-]){5}([0-9A-Fa-f]{2})$/.test(trimmed) ||
    /^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/.test(trimmed) ||
    /^[0-9A-Fa-f]{12}$/.test(trimmed)
  );
}

/**
 * Derives a human-friendly name from a URL (defaults to hostname).
 */
export function derivePortalName(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname || urlStr;
  } catch {
    return urlStr.replace(/^https?:\/\//i, '').split('/')[0] || urlStr;
  }
}

/**
 * Normalizes a MAC address to uppercase colon-separated format (e.g., 00:1A:79:XX:XX:XX).
 * Handles colon (:), hyphen (-), dot (.), Cisco (XXXX.XXXX.XXXX), and compact hex formats.
 */
export function normalizeMacAddress(mac: string): string {
  const clean = mac.trim().replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (clean.length === 12) {
    return clean.match(/.{1,2}/g)?.join(':') || mac.toUpperCase();
  }
  return mac.trim().replace(/[-.]/g, ':').toUpperCase();
}

/**
 * Checks if a string line looks like a URL or bare hostname/domain.
 */
function isPotentialUrl(line: string): boolean {
  if (isMacAddress(line)) return false;
  if (/^https?:\/\//i.test(line)) return true;
  // Bare domain or IP with optional port and path (no whitespace)
  if (!/\s/.test(line) && line.includes('.')) {
    return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/.*)?$/.test(line);
  }
  return false;
}

/**
 * Parses multi-line text input containing Stalker Portal URLs and MAC addresses.
 *
 * Each URL starts a new Stalker source.
 * The first MAC address under each URL becomes its primary MAC, and any
 * subsequent MAC addresses become backup MACs.
 *
 * Comments beginning with '#' or '//' are treated as custom names or notes.
 */
export function parseBulkStalkerInput(text: string): ParsedStalkerPortal[] {
  if (!text || !text.trim()) return [];

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const portals: ParsedStalkerPortal[] = [];
  let current: { name?: string; url?: string; macs: string[] } | null = null;

  for (const line of lines) {
    // 1. Check for comment/custom name prefix
    if (line.startsWith('#') || line.startsWith('//')) {
      const customName = line.replace(/^[#//\s]+/, '').trim();
      if (customName) {
        if (!current) {
          current = { name: customName, macs: [] };
        } else if (!current.url) {
          // Name before URL
          current.name = customName;
        } else if (current.macs.length === 0) {
          // Comment placed between URL and first MAC - don't drop the URL!
          if (!current.name || current.name === derivePortalName(current.url)) {
            current.name = customName;
          }
        } else {
          // Comment after a completed portal entry (has URL and MACs)
          portals.push({
            id: crypto.randomUUID(),
            name: current.name || derivePortalName(current.url),
            url: current.url,
            mac: current.macs[0],
            backupMacs: current.macs.slice(1),
          });
          current = { name: customName, macs: [] };
        }
      }
      continue;
    }

    // 2. Check for MAC address
    if (isMacAddress(line)) {
      const normalized = normalizeMacAddress(line);
      if (current && current.url) {
        current.macs.push(normalized);
      }
      continue;
    }

    // 3. Check for URL / Host
    if (isPotentialUrl(line)) {
      if (current && current.url && current.macs.length > 0) {
        portals.push({
          id: crypto.randomUUID(),
          name: current.name || derivePortalName(current.url),
          url: current.url,
          mac: current.macs[0],
          backupMacs: current.macs.slice(1),
        });
      }

      let formattedUrl = line;
      if (!/^https?:\/\//i.test(formattedUrl)) {
        formattedUrl = `http://${formattedUrl}`;
      }

      const existingName = current && !current.url ? current.name : undefined;
      current = {
        name: existingName || derivePortalName(formattedUrl),
        url: formattedUrl,
        macs: [],
      };
    }
  }

  // Push final entry
  if (current && current.url && current.macs.length > 0) {
    portals.push({
      id: crypto.randomUUID(),
      name: current.name || derivePortalName(current.url),
      url: current.url,
      mac: current.macs[0],
      backupMacs: current.macs.slice(1),
    });
  }

  return portals;
}
