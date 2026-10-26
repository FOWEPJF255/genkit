/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type CLIOutput = EventEmitter & { stdout: EventEmitter };

function readUntilOutput<T>(
  child: CLIOutput,
  parse: (stdout: string) => T | undefined,
  stderr: () => string,
  timeoutMs = 60000
): Promise<T> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const finish = (result: { value: T } | { error: unknown }) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      try {
        const value = parse(stdout);
        if (value !== undefined) finish({ value });
      } catch (error) {
        finish({ error });
      }
    };
    const onError = (error: Error) => finish({ error });
    const onClose = () =>
      finish({ error: new Error(`CLI closed: ${stderr()}`) });
    const timeout = setTimeout(
      () =>
        finish({ error: new Error(`CLI timed out: ${stdout}\n${stderr()}`) }),
      timeoutMs
    );
    child.once('error', onError);
    child.once('close', onClose);
    child.stdout.on('data', onData);
  });
}

function spawnCLI(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'genkit-cli-first-run-'));
  const cli = resolve(__dirname, '../dist/bin/genkit.js');
  const updates = resolve(__dirname, '../dist/utils/updates.js');
  // Make a pending update deterministic without contacting the npm registry.
  const bootstrap = `
    process.argv = [process.execPath, 'genkit', ...${JSON.stringify(args)}];
    require(${JSON.stringify(updates)}).showUpdateNotification = async () => {
      console.log('UPDATE_NOTIFICATION');
    };
    require(${JSON.stringify(cli)});
  `;
  const child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      APPDATA: join(home, 'AppData'),
      GENKIT_DOCS_BUNDLE_URL: 'data:application/json,{}',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  return {
    child,
    async readUntil<T>(parse: (stdout: string) => T | undefined): Promise<T> {
      return readUntilOutput(child, parse, () => stderr);
    },
    async close() {
      child.kill();
      await closed;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function outputListeners(child: CLIOutput) {
  return {
    data: child.stdout.listenerCount('data'),
    error: child.listenerCount('error'),
    close: child.listenerCount('close'),
  };
}

describe('CLI output reader lifecycle', () => {
  it.each([
    'success',
    'parser error',
    'child error',
    'child close',
    'timeout',
  ] as const)('releases listeners and timer after %s', async (outcome) => {
    jest.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
      });
      const failure = new Error('test failure');
      const result = readUntilOutput(
        child,
        (stdout) => {
          if (outcome === 'parser error') throw failure;
          return stdout === 'ready' ? stdout : undefined;
        },
        () => 'test stderr'
      );
      if (outcome === 'success') {
        child.stdout.emit('data', Buffer.from('ready'));
        await expect(result).resolves.toBe('ready');
      } else {
        const expected =
          outcome === 'child close'
            ? 'CLI closed: test stderr'
            : outcome === 'timeout'
              ? 'CLI timed out:'
              : 'test failure';
        const rejection = expect(result).rejects.toThrow(expected);
        if (outcome === 'parser error')
          child.stdout.emit('data', Buffer.from('ready'));
        else if (outcome === 'child error') child.emit('error', failure);
        else if (outcome === 'child close') child.emit('close');
        else jest.advanceTimersByTime(60000);
        await rejection;
      }
      expect(outputListeners(child)).toEqual({ data: 0, error: 0, close: 0 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('CLI first-run stdio', () => {
  it.each([{ args: ['mcp'] }, { args: ['--no-update-notification', 'mcp'] }])(
    'completes MCP initialization with JSON-only stdout: $args',
    async ({ args }) => {
      const cli = spawnCLI(args);
      const listeners = outputListeners(cli.child);
      try {
        const waitForResponse = (id: number) =>
          cli.readUntil((stdout) => {
            const lines = stdout.split('\n');
            lines.pop(); // The final frame may still be incomplete.
            const messages = lines
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            return messages.find((message) => message.id === id);
          });
        const response = waitForResponse(1);
        cli.child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'first-run-test', version: '1.0.0' },
            },
          }) + '\n'
        );
        expect((await response).result.serverInfo.name).toBe('Genkit MCP');
        expect(outputListeners(cli.child)).toEqual(listeners);
        const tools = waitForResponse(2);
        cli.child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          }) +
            '\n' +
            JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
            '\n'
        );
        expect((await tools).result.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'get_usage_guide' }),
          ])
        );
        expect(outputListeners(cli.child)).toEqual(listeners);
      } finally {
        await cli.close();
      }
    },
    75000
  );

  it('preserves the first-run prompt and update notification for ordinary commands', async () => {
    const cli = spawnCLI(['start']);
    const listeners = outputListeners(cli.child);
    try {
      const stdout = await cli.readUntil((stdout) =>
        stdout.includes('Press "Enter" to acknowledge and continue')
          ? stdout
          : undefined
      );
      expect(stdout).toContain('UPDATE_NOTIFICATION');
      expect(stdout).toContain('Genkit CLI and Developer UI use cookies');
      expect(outputListeners(cli.child)).toEqual(listeners);
    } finally {
      await cli.close();
    }
  }, 75000);
});
