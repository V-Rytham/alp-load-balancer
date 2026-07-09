const emit = (level, message, fields) => {
  const suffix = fields && Object.keys(fields).length
    ? ` ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ')}`
    : '';
  process.stdout.write(`[lb] ${level} ${message}${suffix}\n`);
};

export const logger = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
