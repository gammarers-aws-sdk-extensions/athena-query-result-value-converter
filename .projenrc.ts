import { ProjenTypeScriptProject } from '@gammarers/projen-projects';
const project = new ProjenTypeScriptProject({
  name: 'athena-query-result-value-converter',
  repositoryUrl: 'https://github.com/gammarers-aws-sdk-extensions/athena-query-result-value-converter.git',
  description: 'A small TypeScript library that converts Amazon Athena query result cell values using ColumnInfo types from @aws-sdk/client-athena.',
  keywords: [
    'athena',
    'query',
    'result',
    'value',
    'converter',
    'aws',
    'aws-sdk',
  ],
  deps: [
    '@aws-sdk/client-athena@^3.983.0',
  ],
  devDeps: [
    '@gammarers/projen-projects@^0.5.8',
  ],
  releaseToNpm: true,
  // npmTrustedPublishing: true,
});
project.synth();
