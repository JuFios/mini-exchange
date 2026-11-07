-- Перевірка власника й зміна TTL або видалення виконуються атомарно.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == 'renew' then return redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return redis.call('DEL', KEYS[1])
