import { createHttpFramedPair } from '../../../core-transport/src/__tests__/fixtures/http-pair';
import {
  describeCanopyClientConformance,
  type CanopyClientConformancePair,
} from './client-conformance';

// The shared client over the HTTP binding's client half; the fixture says
// what this proves and where the web core itself is covered.
describeCanopyClientConformance(
  'http (client binding)',
  async (): Promise<CanopyClientConformancePair> => {
    const { client, server } = await createHttpFramedPair();
    return {
      client,
      server,
      close: () => {
        client.close();
        server.close();
        return Promise.resolve();
      },
    };
  },
  {
    serverClose: false,
  },
);
