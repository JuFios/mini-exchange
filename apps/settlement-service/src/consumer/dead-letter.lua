-- XADD у DLQ і XACK виконуються разом; повтор після втраченої відповіді не дублює запис.
if #redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[2], ARGV[2], 1) == 0 then return 0 end
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[5], '*',
  'sourceStream', KEYS[1], 'sourceId', ARGV[2], 'reason', ARGV[3], 'fields', ARGV[4])
return redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
