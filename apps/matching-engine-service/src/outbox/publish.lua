local field, position, maxLen = ARGV[1], ARGV[2], ARGV[3]
local latest = redis.call('HGET', KEYS[1], field)

-- Порівнюємо десяткові bigint без округлення Lua number.
if latest and (#latest > #position or (#latest == #position and latest > position)) then
  return false
end

-- Якщо XADD відхилено, цей самий рядок можна повторити з тією самою позицією.
redis.call('HSET', KEYS[1], field, position)
return redis.call('XADD', KEYS[2], 'MAXLEN', '~', maxLen, '*', unpack(ARGV, 4))
