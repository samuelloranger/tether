#include "libssh2.h"

LIBSSH2_CHANNEL *tether_libssh2_channel_open_session(LIBSSH2_SESSION *session);
int tether_libssh2_channel_request_pty(
  LIBSSH2_CHANNEL *channel,
  const char *term,
  unsigned int term_len,
  int width,
  int height
);
int tether_libssh2_channel_shell(LIBSSH2_CHANNEL *channel);
ssize_t tether_libssh2_channel_read(
  LIBSSH2_CHANNEL *channel,
  char *buffer,
  size_t buffer_length
);
ssize_t tether_libssh2_channel_write(
  LIBSSH2_CHANNEL *channel,
  const char *buffer,
  size_t buffer_length
);
