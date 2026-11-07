// Правила комітів і назв PR: Conventional Commits 1.0.0 із закритим списком scope.
// Правила задано явно, без `extends`: так перевірка працює через `npx` без встановлення
// пакетів у репозиторій.
module.exports = {
  // Стандартний парсер не знає `!` перед двокрапкою, тому `feat(engine)!: ...` давав би
  // помилки type-empty і subject-empty. Шаблон такий самий, як у пресеті conventionalcommits.
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
      noteKeywords: ['BREAKING CHANGE', 'BREAKING-CHANGE'],
    },
  },
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'docs', 'build', 'ci', 'chore', 'perf', 'style', 'revert'],
    ],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],
    'scope-case': [2, 'always', 'kebab-case'],
    'scope-enum': [
      2,
      'always',
      [
        'engine',
        'settlement',
        'frontend',
        'matching',
        'orders',
        'intake',
        'ownership',
        'outbox',
        'consumer',
        'ledger',
        'reservations',
        'reconciliation',
        'realtime',
        'auth',
        'db',
        'observability',
        'security',
        'compose',
        'docker',
        'deps',
        'readme',
        'system',
      ],
    ],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 72],
    'body-leading-blank': [2, 'always'],
    'body-max-line-length': [2, 'always', 72],
    'footer-leading-blank': [2, 'always'],
  },
};
