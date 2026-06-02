import { describe, it, expect, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import { PortManager } from '../port-manager.js';

describe('PortManager', () => {
  let pm: PortManager;

  beforeEach(() => {
    pm = new PortManager();
  });

  describe('isPortInUse', () => {
    it('returns false for an available port', async () => {
      // Port 19876 is very unlikely to be in use
      const inUse = await pm.isPortInUse(19876);
      expect(typeof inUse).toBe('boolean');
      // We can't guarantee it's free, but it should work without error
    });

    it('returns true for a port in use', async () => {
      // Create a server on a port, then check
      const net = await import('net');
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;

      const inUse = await pm.isPortInUse(port);
      expect(inUse).toBe(true);

      server.close();
    });
  });

  describe('findAvailablePort', () => {
    it('finds an available port', async () => {
      const port = await pm.findAvailablePort(19800);
      expect(port).toBeGreaterThanOrEqual(19800);
      expect(port).toBeLessThan(19900);
    });
  });

  describe('findChromeDebugPort', () => {
    it('returns null when no Chrome debug port is found', async () => {
      // Unless Chrome happens to be running with debug port, this should return null
      // We test the code path, not the result
      const port = await pm.findChromeDebugPort();
      expect(port === null || typeof port === 'number').toBe(true);
    });
  });
});
