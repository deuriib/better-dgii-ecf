/**
 * Documentation snippets are the first code a reader pastes. This test
 * typechecks every fenced TypeScript block in the README and in `docs/`
 * against the real plugin and SDK types. Names the surrounding prose says the
 * application owns (`certificates`, `invoiceXml`, an already configured
 * `authClient`) are declared by the harness; the snippet text itself is
 * compiled unchanged.
 *
 * An invented Result helper is a type error here, so `mise run test` fails
 * the build instead of the reader's first paste.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The method the quick start used to invent. Kept split so this file does not reintroduce it. */
const inventedHelper = ['unwrap', 'OrThrow'].join('');

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.pack',
  '.snippets',
]);

interface Snippet {
  readonly file: string;
  /** 1-based line of the first code line in the markdown file. */
  readonly startLine: number;
  readonly code: string;
}

const docFiles = (): string[] => {
  const docs = readdirSync(join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join('docs', name));
  return ['README.md', 'README.es.md', ...docs];
};

const extractSnippets = (file: string, markdown: string): Snippet[] => {
  const lines = markdown.split('\n');
  const snippets: Snippet[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i];
    if (fence !== '```ts' && fence !== '```typescript') {
      continue;
    }
    const code: string[] = [];
    const startLine = i + 2;
    i++;
    for (; i < lines.length && lines[i] !== '```'; i++) {
      code.push(lines[i] ?? '');
    }
    const text = code.join('\n');
    if (text.trim() !== '') {
      snippets.push({ file, startLine, code: text });
    }
  }
  return snippets;
};

const readSnippets = (): Snippet[] =>
  docFiles().flatMap((file) =>
    extractSnippets(file, readFileSync(join(root, file), 'utf8')),
  );

const mentions = (source: string, name: string): boolean =>
  new RegExp(`\\b${name}\\b`).test(source);

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const takeImports = (source: string): { imports: string; body: string } => {
  const lines = source.split('\n');
  const importLines: string[] = [];
  const bodyLines: string[] = [];
  let inImport = false;
  let depth = 0;
  for (const line of lines) {
    if (!inImport && /^\s*import\b/.test(line)) {
      inImport = true;
      depth = 0;
    }
    if (inImport) {
      importLines.push(line);
      depth += line.split('{').length - 1;
      depth -= line.split('}').length - 1;
      if (depth <= 0 && /from\s+['"][^'"]+['"]/.test(line)) {
        inImport = false;
      }
      continue;
    }
    bodyLines.push(line);
  }
  return { imports: importLines.join('\n'), body: bodyLines.join('\n') };
};

const declares = (source: string, name: string): boolean =>
  new RegExp(
    `\\b(?:const|let|var|function|class|enum|interface|type)\\s+${name}\\b`,
  ).test(source) ||
  new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b`).test(source);

/**
 * Imports added when a snippet uses a library name without importing it.
 * Later fences in a guide omit the import the first fence already showed.
 */
const LIBRARY_IMPORTS: Readonly<Record<string, string>> = {
  betterAuth: `import { betterAuth } from 'better-auth';`,
  organization: `import { organization } from 'better-auth/plugins';`,
  createAuthClient: `import { createAuthClient } from 'better-auth/client';`,
  organizationClient: `import { organizationClient } from 'better-auth/client/plugins';`,
  P12Reader: `import { P12Reader } from '@deuriib/dgii-ecf';`,
  Environment: `import { Environment } from '@deuriib/dgii-ecf';`,
  dgiiEcf: `import { dgiiEcf } from '@deuriib/better-dgii-ecf';`,
  dgiiEcfOrganizationSchema: `import { dgiiEcfOrganizationSchema } from '@deuriib/better-dgii-ecf';`,
  dgiiEcfClient: `import { dgiiEcfClient } from '@deuriib/better-dgii-ecf/client';`,
};

const HOST_LINES: Readonly<Record<string, readonly string[]>> = {
  certificates: [
    'declare const certificates: {',
    '  for(taxPayerId: string): Promise<{ password: string; base64: string }>;',
    '  load(query: {',
    '    taxPayerId: string;',
    '    organizationId: string | null;',
    '  }): Promise<{ password: string; base64: string } | null>;',
    '};',
  ],
  invoiceXml: ['declare const invoiceXml: string;'],
  xml: ['declare const xml: string;'],
  headers: ['declare const headers: Headers;'],
  canonicalRnc: ['declare function canonicalRnc(id: string): string | false;'],
  PILOT_RNC: ['declare const PILOT_RNC: string;'],
  pool: [
    'declare const pool: {',
    "  acquire(taxPayerId: string): Promise<import('@deuriib/dgii-ecf').ECF>;",
    '};',
  ],
  db: [
    'declare const db: {',
    '  taxProfile: {',
    '    findByUser(userId: string): Promise<{ rnc?: string } | null>;',
    '  };',
    '};',
  ],
  isPlatformAdmin: [
    'declare function isPlatformAdmin(userId: string): boolean | Promise<boolean>;',
  ],
  loadCertificate: [
    "declare function loadCertificate(): import('@deuriib/dgii-ecf').P12ReaderData;",
  ],
  loadSingleTenantCertificate: [
    'declare function loadSingleTenantCertificate(): Promise<',
    "  import('@deuriib/dgii-ecf').P12ReaderData",
    '>;',
  ],
};

interface VirtualFile {
  readonly text: string;
  /** 0-based line index where the original snippet begins. */
  readonly bodyStart: number;
}

/**
 * Build a compilation unit around a snippet.
 *
 * The snippet's own text is inserted verbatim. Imports and declarations around
 * it stand in for the application the guide assumes is already there: storage,
 * a configured auth client, a single-tenant certificate loader.
 */
const buildVirtual = (snippet: Snippet): VirtualFile => {
  const { imports, body } = takeImports(snippet.code);
  const scanned = stripComments(body);
  const imported = (name: string): boolean => mentions(imports, name);
  const declared = (name: string): boolean => declares(scanned, name);
  const used = (name: string): boolean => mentions(scanned, name);
  const needed = new Set<string>();

  for (const name of Object.keys(LIBRARY_IMPORTS)) {
    if (used(name) && !imported(name) && !declared(name)) {
      needed.add(name);
    }
  }

  const host: string[] = [];
  for (const [name, lines] of Object.entries(HOST_LINES)) {
    if (used(name) && !declared(name) && !imported(name)) {
      host.push(...lines);
    }
  }

  const needsCredentials = used('credentials') && !declared('credentials');
  const needsResolver = used('resolveCredentials') && !declared('resolveCredentials');
  if (needsCredentials || needsResolver) {
    needed.add('dgiiEcf');
    host.push(
      'type DocSnippetCredentials = NonNullable<',
      "  NonNullable<Parameters<typeof dgiiEcf>[0]>['credentials']",
      '>;',
    );
    if (needsCredentials) {
      host.push('declare const credentials: DocSnippetCredentials;');
    }
    if (needsResolver) {
      host.push('declare const resolveCredentials: DocSnippetCredentials;');
    }
  }

  if (used('auth') && !declared('auth')) {
    needed.add('betterAuth');
    needed.add('organization');
    needed.add('dgiiEcf');
    needed.add('dgiiEcfOrganizationSchema');
    host.push(
      'const auth = betterAuth({',
      '  plugins: [',
      '    organization({ schema: { organization: dgiiEcfOrganizationSchema() } }),',
      '    dgiiEcf({ credentials: async () => null }),',
      '  ],',
      '});',
    );
  }

  if (used('authClient') && !declared('authClient')) {
    needed.add('createAuthClient');
    needed.add('organizationClient');
    needed.add('dgiiEcfClient');
    needed.add('dgiiEcfOrganizationSchema');
    host.push(
      'const authClient = createAuthClient({',
      '  plugins: [',
      '    organizationClient({',
      '      schema: {',
      '        organization: {',
      '          additionalFields: dgiiEcfOrganizationSchema().additionalFields,',
      '        },',
      '      },',
      '    }),',
      '    dgiiEcfClient(),',
      '  ],',
      '});',
    );
  }

  const addedImports = [...needed]
    .filter((name) => !imported(name))
    .map((name) => LIBRARY_IMPORTS[name])
    .filter((line): line is string => line !== undefined);

  // The snippet is appended verbatim, including its own imports. Only names it
  // does not import are added above it.
  const headerLines = [...addedImports, ...host];
  const text = [...headerLines, snippet.code, 'export {}', ''].join('\n');
  return { text, bodyStart: headerLines.length };
};

const compilerOptions = (): ts.CompilerOptions => ({
  strict: true,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  types: ['node'],
  skipLibCheck: true,
  noEmit: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  baseUrl: root,
  paths: {
    '@deuriib/better-dgii-ecf': ['src/index.ts'],
    '@deuriib/better-dgii-ecf/client': ['src/client.ts'],
  },
});

const createHost = (
  files: ReadonlyMap<string, string>,
  options: ts.CompilerOptions,
): ts.CompilerHost => {
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const text = files.get(fileName);
    if (text !== undefined) {
      return ts.createSourceFile(
        fileName,
        text,
        languageVersion,
        true,
        ts.ScriptKind.TS,
      );
    }
    return originalGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  const originalExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => files.has(fileName) || originalExists(fileName);
  const originalRead = host.readFile.bind(host);
  host.readFile = (fileName) => files.get(fileName) ?? originalRead(fileName);
  return host;
};

const snippetDiagnostics = (snippets: readonly Snippet[]): string[] => {
  const virtual = new Map<
    string,
    { text: string; bodyStart: number; snippet: Snippet }
  >();
  snippets.forEach((snippet, index) => {
    const built = buildVirtual(snippet);
    virtual.set(join(root, 'test', '.snippets', `${index}.ts`), {
      text: built.text,
      bodyStart: built.bodyStart,
      snippet,
    });
  });

  const options = compilerOptions();
  const sources = new Map<string, string>();
  for (const [fileName, file] of virtual) {
    sources.set(fileName, file.text);
  }
  const program = ts.createProgram(
    [...sources.keys()],
    options,
    createHost(sources, options),
  );
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
    return diagnostic.category === ts.DiagnosticCategory.Error;
  });

  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return message;
    }
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const lineText = diagnostic.file.text.split('\n')[position.line] ?? '';
    const virtualFile = virtual.get(diagnostic.file.fileName);
    if (virtualFile === undefined) {
      return `${diagnostic.file.fileName}:${position.line + 1}: ${message}\n  ${lineText.trim()}`;
    }
    const { snippet, bodyStart } = virtualFile;
    const bodyLines = snippet.code.split('\n').length;
    const where =
      position.line >= bodyStart && position.line < bodyStart + bodyLines
        ? `${snippet.file}:${snippet.startLine + (position.line - bodyStart)}`
        : `harness for ${snippet.file}:${snippet.startLine}`;
    return `${where}: ${message}\n  ${lineText.trim()}`;
  });
};

const walk = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
};

describe('documentation snippets', () => {
  it('does not mention the invented Result helper anywhere in the repository', () => {
    const hits: string[] = [];
    for (const path of walk(root)) {
      const bytes = readFileSync(path);
      if (bytes.includes(0)) {
        continue;
      }
      const text = bytes.toString('utf8');
      if (!text.includes(inventedHelper)) {
        continue;
      }
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (line.includes(inventedHelper)) {
          hits.push(`${relative(root, path)}:${index + 1}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('typechecks every fenced snippet as written', () => {
    const snippets = readSnippets();
    expect(snippets.length).toBeGreaterThan(20);

    const headline = snippets.find(
      (snippet) =>
        snippet.file === 'README.md' && snippet.code.includes('getKeyFromStringBase64'),
    );
    expect(headline).toBeDefined();
    expect(buildVirtual(headline!).text).toContain(headline!.code);

    expect(snippetDiagnostics(snippets)).toEqual([]);
  }, 120_000);

  it('unwraps getKeyFromStringBase64 with one isErr check everywhere it is shown', () => {
    const idiom =
      /const parsed = new P12Reader\([\w.]+\.password\)\s*\.getKeyFromStringBase64\([\w.]+\.base64\);\s*if \(parsed\.isErr\(\)\) \{\s*throw parsed\.error;\s*\}\s*return parsed\.value;/;
    const shown = readSnippets().filter((snippet) =>
      snippet.code.includes('getKeyFromStringBase64'),
    );
    expect(shown.map((snippet) => snippet.file)).toEqual([
      'README.md',
      'README.es.md',
      'docs/usage.md',
    ]);
    for (const snippet of shown) {
      expect(snippet.code).toMatch(idiom);
    }
  });
});
