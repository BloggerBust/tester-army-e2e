import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readSocketLines } from '../../src/run/step-socket.ts';

describe('attachment socket messages', () => {
  it('reads complete messages when a socket splits or joins lines', () => {
    const socket = new Socket();
    try {
      const lines: string[] = [];
      readSocketLines(socket, (line) => {
        lines.push(line);
        return lines.length < 2;
      });
      socket.emit('data', '{"type":"');
      socket.emit('data', 'detach"}\n{"action":"next"}\n{"action":"stop"}\n');
      socket.emit('data', '{"action":"rest"}\n');
      expect(lines).toEqual(['{"type":"detach"}', '{"action":"next"}']);
    } finally {
      socket.destroy();
    }
  });
});
