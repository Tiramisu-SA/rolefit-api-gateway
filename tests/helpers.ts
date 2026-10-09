import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

/** Starts the app on a random local port. */
export async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: { field: string; message: string }[];
}

export const errorOf = async (res: Response) => ((await res.json()) as { error: ErrorBody }).error;
