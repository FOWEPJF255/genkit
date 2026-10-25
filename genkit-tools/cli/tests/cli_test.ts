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

import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      return new Promise((resolve, reject) => {
        let stdout = '';
        const timeout = setTimeout(
          () => reject(new Error(`CLI timed out: ${stdout}\n${stderr}`)),
          60000
        );
        const finish = (error?: Error, value?: T) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(value!);
        };
        child.once('error', (error) => finish(error));
        child.once('close', () => finish(new Error(`CLI closed: ${stderr}`)));
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
          try {
            const value = parse(stdout);
            if (value !== undefined) finish(undefined, value);
          } catch (error) {
            finish(error as Error);
          }
        });
      });
    },
    async close() {
      child.kill();
      await closed;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('CLI first-run stdio', () => {
  it.each([{ args: ['mcp'] }, { args: ['--no-update-notification', 'mcp'] }])(
    'completes MCP initialization with JSON-only stdout: $args',
    async ({ args }) => {
      const cli = spawnCLI(args);
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
      } finally {
        await cli.close();
      }
    },
    75000
  );

  it('preserves the first-run prompt and update notification for ordinary commands', async () => {
    const cli = spawnCLI(['start']);
    try {
      const stdout = await cli.readUntil((stdout) =>
        stdout.includes('Press "Enter" to acknowledge and continue')
          ? stdout
          : undefined
      );
      expect(stdout).toContain('UPDATE_NOTIFICATION');
      expect(stdout).toContain('Genkit CLI and Developer UI use cookies');
    } finally {
      await cli.close();
    }
  }, 75000);
});
