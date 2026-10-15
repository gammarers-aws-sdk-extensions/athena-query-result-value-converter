import { ProjenTypeScriptProject } from '@gammarers/projen-projects';
const project = new ProjenTypeScriptProject({
  name: 'athena-query-result-value-converter',
  repositoryUrl: 'https://github.com/gammarers-aws-sdk-extensions/athena-query-result-value-converter.git',
  devDeps: [
    '@gammarers/projen-projects@^0.5.8',
  ],
});
project.synth();