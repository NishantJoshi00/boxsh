/* boxsh native embedding — C declarations for libboxsh_ffi.
 *
 * Every call returns 0 (or an exit code >= 0 for exec) on success, or a
 * negative status: -1 ENOENT, -2 EEXIST, -3 ENOTDIR, -4 EISDIR,
 * -5 ENOTEMPTY, -6 EINVAL, -7 EIO, -8 corrupt, -9 bad handle, -10 UTF-8.
 * Buffers written into boxsh_buf are owned by the caller afterwards; free
 * them with boxsh_buf_free. Strings are UTF-8, not NUL-terminated
 * (explicit lengths everywhere).
 */
#ifndef BOXSH_H
#define BOXSH_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint8_t *ptr;
  size_t len;
} boxsh_buf;

/* Sandbox lifecycle. A handle owns a filesystem and a shell session.
 * -11 (busy) means the handle is executing on another thread. */
int32_t boxsh_sandbox_new(void);
int32_t boxsh_sandbox_free(int32_t handle);

/* Session environment (HOME, USER, PATH etc. are preset). */
int32_t boxsh_sandbox_set_env(int32_t handle, const uint8_t *key,
                              size_t key_len, const uint8_t *value,
                              size_t value_len);

/* Run a shell script; returns its exit code. env/cwd/$? persist. */
int32_t boxsh_sandbox_exec(int32_t handle, const uint8_t *script,
                           size_t script_len, boxsh_buf *out, boxsh_buf *err);

/* Direct file access. write creates parent directories. */
int32_t boxsh_sandbox_read_file(int32_t handle, const uint8_t *path,
                                size_t path_len, boxsh_buf *out);
int32_t boxsh_sandbox_write_file(int32_t handle, const uint8_t *path,
                                 size_t path_len, const uint8_t *data,
                                 size_t data_len);

/* Whole-workspace snapshots as tar archives. */
int32_t boxsh_sandbox_export_tar(int32_t handle, boxsh_buf *out);
int32_t boxsh_sandbox_import_tar(int32_t handle, const uint8_t *tar,
                                 size_t tar_len);

void boxsh_buf_free(boxsh_buf buf);

#endif /* BOXSH_H */
