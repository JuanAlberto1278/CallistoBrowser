chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m === 'ping-offscreen') reply('pong-offscreen:' + new DOMParser().parseFromString('<p>ok</p>', 'text/html').body.textContent);
});
