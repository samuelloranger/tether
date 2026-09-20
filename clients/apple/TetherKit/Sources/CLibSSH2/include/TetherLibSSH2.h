#include "libssh2.h"

// libssh2 exposes these as C macros, which Swift cannot see. Thin wrappers make
// them callable from Swift.
LIBSSH2_SESSION *tether_libssh2_session_init(void);
int tether_libssh2_userauth_password(
  LIBSSH2_SESSION *session,
  const char *username,
  const char *password
);
int tether_libssh2_session_disconnect(LIBSSH2_SESSION *session, const char *description);

LIBSSH2_CHANNEL *tether_libssh2_channel_open_session(LIBSSH2_SESSION *session);
int tether_libssh2_channel_request_pty(
  LIBSSH2_CHANNEL *channel,
  const char *term,
  unsigned int term_len,
  int width,
  int height
);
int tether_libssh2_channel_shell(LIBSSH2_CHANNEL *channel);
int tether_libssh2_channel_exec(LIBSSH2_CHANNEL *channel, const char *command);
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
