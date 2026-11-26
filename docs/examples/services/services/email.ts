import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { defineService } from 'e2e';

type Email = {
  to: string;
  subject: string;
};

export const email = defineService({
  async *start({ signal }) {
    const emails: Email[] = [];

    const server = createServer(async (request, response) => {
      emails.push(JSON.parse(await text(request)));
      response.end();
    });

    server.listen({ port: 0, host: '127.0.0.1', signal });

    await once(server, 'listening', { signal });

    const serverAddress = server.address();

    if (serverAddress === null || typeof serverAddress === 'string') {
      throw new Error('The email server has no TCP address.');
    }

    const received = (address: string) => emails.filter((message) => message.to === address);

    yield {
      url: `http://127.0.0.1:${serverAddress.port}`,
      createInbox: () => ({ address: `${randomUUID()}@example.com` }),
      received,
      waitForEmail: async (address: string, { subject }: { subject: RegExp }) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const match = received(address).find((message) => subject.test(message.subject));

          if (match !== undefined) {
            return match;
          }

          await setTimeout(100);
        }

        throw new Error(`no email to ${address} with a subject matching ${subject} arrived within 10 seconds`);
      },
    };

    server.close();

    await once(server, 'close');
  },
});
