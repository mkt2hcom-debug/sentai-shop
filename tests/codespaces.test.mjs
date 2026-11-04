import assert from 'node:assert/strict';
import test from 'node:test';
import { codespacesEnvironment } from '../scripts/start_codespaces.mjs';

const sample = {
  CODESPACES:'true', CODESPACE_NAME:'sentai-quiet-moon-abc123',
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev'
};

test('Codespaces launcher derives its HTTPS origin and retains loopback and private runtime settings', () => {
  const input = {...sample, HOST:'0.0.0.0', PUBLIC_ORIGIN:'https://old.example.test', DB_PATH:'/workspaces/shop/data/shop.sqlite', DATA_ENCRYPTION_KEY_FILE:'/workspaces/shop/data/secrets/order-data.key'};
  const configured = codespacesEnvironment(input);
  assert.equal(configured.PUBLIC_ORIGIN, 'https://sentai-quiet-moon-abc123-3000.app.github.dev');
  assert.equal(configured.HOST, '127.0.0.1');
  assert.equal(configured.PORT, '3000');
  assert.equal(configured.DB_PATH, input.DB_PATH);
  assert.equal(configured.DATA_ENCRYPTION_KEY_FILE, input.DATA_ENCRYPTION_KEY_FILE);
  assert.equal(input.HOST, '0.0.0.0', 'configuration must not mutate the caller environment');
  assert.equal(codespacesEnvironment({...sample,PORT:'4000'}).PUBLIC_ORIGIN, 'https://sentai-quiet-moon-abc123-4000.app.github.dev');
});

test('Codespaces launcher rejects URL injection, lookalike domains, invalid ports and a local invocation', () => {
  assert.throws(() => codespacesEnvironment({}), /GitHub Codespaces/);
  for (const domain of ['app.github.dev.evil.test','app.github.dev:443','https://app.github.dev','app.github.dev/path','app.github.dev@evil.test','app..github.dev','APP.github.dev','app.github.dev\n','app.github.dev?token=secret']) {
    assert.throws(() => codespacesEnvironment({...sample,GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:domain}));
  }
  for (const name of ['','-sentai','sentai-','sentai/path','sentai@host','sentai\n','a'.repeat(60)]) {
    assert.throws(() => codespacesEnvironment({...sample,CODESPACE_NAME:name}));
  }
  for (const port of ['0','03000','65536','3000/path','3000\n','-1','1.5']) {
    assert.throws(() => codespacesEnvironment({...sample,PORT:port}));
  }
});
