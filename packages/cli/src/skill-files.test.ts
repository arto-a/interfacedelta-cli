import './test-network-block.cjs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSkillFiles, skillFileMatcher } from './skill-files';
import { skillFile } from './skills-fixture';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'skills-files-'));
  roots.push(path);
  return path;
}

describe('skill file finder', () => {
  it('finds every default, nested files and extra globs in sorted order; excludes unrelated files', async () => {
    const dir = await root();
    const expected = [
      '.claude/skills/task/notes.txt',
      '.cursor/rules/guide.mdc',
      '.github/copilot-instructions.md',
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'SKILL.md',
      'custom/a.txt',
      'nested/SKILL.md',
      'prompts/deep/system.md',
      'prompts/root.md',
    ];
    for (const path of [
      ...expected,
      'README.md',
      'index.ts',
      'custom/a.json',
      'prompts/not.txt',
    ])
      await skillFile(dir, path, 'read_item');
    expect(
      (await findSkillFiles(dir, { include: ['custom/*.txt'] })).files,
    ).toEqual(expected);
  });
  it('uses the released skip list, even with an include glob', async () => {
    const dir = await root();
    for (const name of [
      '.git',
      'node_modules',
      'dist',
      'build',
      'out',
      'vendor',
      '.next',
      'coverage',
      '.venv',
      '__pycache__',
      '.interfacedelta',
    ])
      await skillFile(dir, `${name}/SKILL.md`, 'read_item');
    await skillFile(dir, 'AGENTS.md', 'read_item');
    expect((await findSkillFiles(dir, { include: ['**/*'] })).files).toEqual([
      'AGENTS.md',
    ]);
  });
  it('skips loops, outside-root file and directory symlinks; refuses a symlink root', async () => {
    const dir = await root(),
      outside = await root();
    await skillFile(outside, 'SKILL.md', 'private');
    await skillFile(dir, 'AGENTS.md', 'read_item');
    await symlink(dir, join(dir, 'loop'));
    await symlink(outside, join(dir, 'outside'));
    await symlink(join(outside, 'SKILL.md'), join(dir, 'SKILL.md'));
    expect((await findSkillFiles(dir)).files).toEqual(['AGENTS.md']);
    await expect(findSkillFiles(join(dir, 'loop'))).rejects.toThrow('symlink');
  });
  it('marks actual file and byte cap cuts, searching complete lines only', async () => {
    const dir = await root();
    await skillFile(dir, 'AGENTS.md', 'id\nread_item\n');
    await skillFile(dir, 'SKILL.md', 'read_item');
    expect(
      await findSkillFiles(dir, { limits: { maxFiles: 1 } }),
    ).toMatchObject({ truncated: true, filesRead: 1 });
    const result = await findSkillFiles(dir, { limits: { maxBytes: 5 } });
    expect(result).toMatchObject({ truncated: true, bytesRead: 5 });
    expect(
      await findSkillFiles(dir, { limits: { maxFiles: 2 } }),
    ).toMatchObject({ truncated: false, filesRead: 2 });
  });
  it('skips binary and files over 1 MiB without returning contents', async () => {
    const dir = await root();
    await skillFile(dir, 'AGENTS.md', '\0read_item');
    await skillFile(dir, 'SKILL.md', 'x'.repeat(1024 * 1024 + 1));
    expect(await findSkillFiles(dir)).toEqual({
      files: [],
      filesRead: 2,
      bytesRead: 10,
      truncated: false,
    });
  });
  it('supports bounded *, ** and ? globs and rejects escaping or unsupported patterns', () => {
    const match = skillFileMatcher(['**/guide?.txt']);
    expect(match('guide1.txt')).toBe(true);
    expect(match('deep/guide2.txt')).toBe(true);
    expect(match('deep/guide22.txt')).toBe(false);
    for (const pattern of ['../*', '/tmp/*', '{a,b}', '[ab]', 'x\\y', ''])
      expect(() => skillFileMatcher([pattern])).toThrow('--include');
    expect(skillFileMatcher([`${'*a'.repeat(100)}z`])('a'.repeat(200))).toBe(
      false,
    );
  });
});
