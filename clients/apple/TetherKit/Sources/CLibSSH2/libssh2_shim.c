#include "TetherLibSSH2.h"

LIBSSH2_SESSION *tether_libssh2_session_init(void) {
  return libssh2_session_init();
}

int tether_libssh2_userauth_password(
  LIBSSH2_SESSION *session,
  const char *username,
  const char *password
) {
  return libssh2_userauth_password(session, username, password);
}

int tether_libssh2_session_disconnect(LIBSSH2_SESSION *session, const char *description) {
  return libssh2_session_disconnect(session, description);
}

LIBSSH2_CHANNEL *tether_libssh2_channel_open_session(LIBSSH2_SESSION *session) {
  return libssh2_channel_open_session(session);
}

int tether_libssh2_channel_request_pty(
  LIBSSH2_CHANNEL *channel,
  const char *term,
  unsigned int term_len,
  int width,
  int height
) {
  return libssh2_channel_request_pty_ex(channel, term, term_len, NULL, 0, width, height, 0, 0);
}

int tether_libssh2_channel_shell(LIBSSH2_CHANNEL *channel) {
  return libssh2_channel_shell(channel);
}

int tether_libssh2_channel_exec(LIBSSH2_CHANNEL *channel, const char *command) {
  return libssh2_channel_exec(channel, command);
}

int tether_libssh2_channel_request_pty_size(LIBSSH2_CHANNEL *channel, int width, int height) {
  return libssh2_channel_request_pty_size_ex(channel, width, height, 0, 0);
}

ssize_t tether_libssh2_channel_read(
  LIBSSH2_CHANNEL *channel,
  char *buffer,
  size_t buffer_length
) {
  return libssh2_channel_read_ex(channel, 0, buffer, buffer_length);
}

ssize_t tether_libssh2_channel_write(
  LIBSSH2_CHANNEL *channel,
  const char *buffer,
  size_t buffer_length
) {
  return libssh2_channel_write_ex(channel, 0, buffer, buffer_length);
}
