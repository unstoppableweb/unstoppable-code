/* Windows counterpart of openat(O_NOFOLLOW). Each NtCreateFile call names
 * exactly one component relative to the previous directory HANDLE. Reparse
 * points, hard links, devices, UNC paths, and alternate streams fail closed.
 * https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <io.h>
#include <fcntl.h>
#include <wchar.h>
#include <stddef.h>

typedef HANDLE broker_handle;
#define BAD_HANDLE INVALID_HANDLE_VALUE
static void close_handle(broker_handle handle) { CloseHandle(handle); }
typedef NTSTATUS (NTAPI *broker_nt_create)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

static bool safe_info(HANDLE handle, bool directory, BY_HANDLE_FILE_INFORMATION *info) {
  return GetFileType(handle) == FILE_TYPE_DISK && GetFileInformationByHandle(handle, info) &&
    !(info->dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
    !!(info->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory &&
    (directory || (info->nNumberOfLinks == 1 && !info->nFileSizeHigh && (size_t)info->nFileSizeLow <= file_bound));
}

static bool safe_long_name(HANDLE handle) {
  unsigned char *buffer = malloc(32768);
  if (!buffer) return false;
  bool ok = false;
  if (GetFileInformationByHandleEx(handle, FileNameInfo, buffer, 32768)) {
    FILE_NAME_INFO *info = (FILE_NAME_INFO *)buffer;
    if (info->FileNameLength % sizeof(wchar_t) == 0 && info->FileNameLength <= 32768 - offsetof(FILE_NAME_INFO, FileName)) {
      size_t count = info->FileNameLength / sizeof(wchar_t), start = count;
      while (start && info->FileName[start-1] != L'\\') --start;
      char name[PATH_BOUND];
      int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, info->FileName + start, (int)(count-start), name, PATH_BOUND-1, NULL, NULL);
      if (n > 0) { name[n] = 0; ok = !private_name(name); }
    }
  }
  free(buffer); return ok;
}

#define BROKER_FILE_OPEN 1
#define BROKER_FILE_CREATE 2
#define BROKER_OPTIONS_DIRECTORY 0x1
#define BROKER_OPTIONS_FILE 0x40
#define BROKER_OPTIONS_SYNC_REPARSE (0x20 /* synchronous */ | 0x200000 /* open reparse itself */)
#define BROKER_STATUS_NOT_FOUND ((NTSTATUS)0xC0000034L) /* STATUS_OBJECT_NAME_NOT_FOUND */

/* One component relative to root, never following reparse points. */
static NTSTATUS nt_open(HANDLE root, const wchar_t *name, ACCESS_MASK access, ULONG share, ULONG disposition, ULONG options, HANDLE *opened) {
  *opened = BAD_HANDLE;
  size_t length = wcslen(name);
  if (!length || length >= PATH_BOUND) return (NTSTATUS)0xC0000033L; /* STATUS_OBJECT_NAME_INVALID */
  // Resolve only the system DLL already loaded by Windows, never PATH or CWD.
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  broker_nt_create create = module ? (broker_nt_create)(void *)GetProcAddress(module, "NtCreateFile") : NULL;
  if (!create) return (NTSTATUS)0xC0000001L; /* STATUS_UNSUCCESSFUL */
  UNICODE_STRING relative = { (USHORT)(length * sizeof(wchar_t)), (USHORT)(length * sizeof(wchar_t)), (PWSTR)name };
  OBJECT_ATTRIBUTES attributes = {0};
  attributes.Length = sizeof(OBJECT_ATTRIBUTES); attributes.RootDirectory = root;
  attributes.ObjectName = &relative; attributes.Attributes = 0x40 /* OBJ_CASE_INSENSITIVE */;
  IO_STATUS_BLOCK io;
  NTSTATUS status = create(opened, access, &attributes, &io, NULL, FILE_ATTRIBUTE_NORMAL, share, disposition, options | BROKER_OPTIONS_SYNC_REPARSE, NULL, 0);
  if (status < 0) *opened = BAD_HANDLE;
  return status;
}

static broker_handle open_component(HANDLE root, wchar_t *name, bool directory, bool policy) {
  HANDLE opened;
  if (nt_open(root, name, (directory ? FILE_LIST_DIRECTORY : FILE_READ_DATA) | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, BROKER_FILE_OPEN /* never create */,
      directory ? BROKER_OPTIONS_DIRECTORY : BROKER_OPTIONS_FILE, &opened) < 0) return BAD_HANDLE;
  BY_HANDLE_FILE_INFORMATION info;
  if (!safe_info(opened, directory, &info) || (policy && !safe_long_name(opened))) { CloseHandle(opened); return BAD_HANDLE; }
  return opened;
}

static broker_handle descend_wide(HANDLE root, wchar_t *path, bool directory, bool policy) {
  HANDLE current;
  if (!DuplicateHandle(GetCurrentProcess(), root, GetCurrentProcess(), &current, 0, FALSE, DUPLICATE_SAME_ACCESS)) return BAD_HANDLE;
  wchar_t *part = path;
  while (*part) {
    wchar_t *separator = wcschr(part, L'/');
    if (separator) *separator = 0;
    if (!wcscmp(part, L".") || !wcscmp(part, L"..") || wcschr(part, L':') || wcschr(part, L'\\')) { CloseHandle(current); return BAD_HANDLE; }
    HANDLE opened = open_component(current, part, separator != NULL || directory, policy);
    CloseHandle(current); if (opened == BAD_HANDLE) return BAD_HANDLE;
    current = opened;
    if (!separator) break;
    part = separator + 1;
  }
  return current;
}

static broker_handle open_relative(HANDLE root, const char *path, bool directory) {
  wchar_t wide[PATH_BOUND];
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, PATH_BOUND)) return BAD_HANDLE;
  return descend_wide(root, wide, directory, true);
}

static broker_handle open_root(const wchar_t *path) {
  size_t length = wcslen(path);
  // Local drive roots only. No UNC, device namespace, drive-relative path or ADS.
  if (length < 3 || length >= PATH_BOUND || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) || path[1] != L':' || (path[2] != L'\\' && path[2] != L'/')) return BAD_HANDLE;
  wchar_t drive[] = { path[0], L':', L'\\', 0 };
  if (GetDriveTypeW(drive) != DRIVE_FIXED) return BAD_HANDLE;
  HANDLE slash = CreateFileW(drive, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (slash == BAD_HANDLE) return BAD_HANDLE;
  BY_HANDLE_FILE_INFORMATION info;
  if (!safe_info(slash, true, &info)) { CloseHandle(slash); return BAD_HANDLE; }
  wchar_t parts[PATH_BOUND];
  if (wcscpy_s(parts, PATH_BOUND, path + 3)) { CloseHandle(slash); return BAD_HANDLE; }
  for (wchar_t *p = parts; *p; ++p) if (*p == L'\\') *p = L'/';
  HANDLE root = descend_wide(slash, parts, true, false); CloseHandle(slash); return root;
}

/* Reads the whole regular file into a new buffer the caller frees. A file
 * that grows past its size while being read is refused. */
static bool read_bytes(HANDLE file, char **bytes, size_t *used) {
  BY_HANDLE_FILE_INFORMATION info;
  *bytes = NULL; *used = 0;
  if (!safe_info(file, false, &info)) return false;
  size_t size = (size_t)info.nFileSizeLow, capacity = size + 1;
  char *buffer = malloc(capacity);
  if (!buffer) return false;
  while (*used < capacity) {
    DWORD count = 0;
    if (!ReadFile(file, buffer + *used, (DWORD)(capacity - *used), &count, NULL)) { free(buffer); return false; }
    if (!count) break;
    *used += count;
  }
  if (*used > size) { free(buffer); return false; }
  *bytes = buffer; return true;
}

static bool list_bytes(HANDLE directory, char *bytes, size_t *used) {
  unsigned char *buffer = malloc(LIST_BOUND);
  if (!buffer) return false;
  *used = 0; unsigned entries = 0; bool ok = true, first = true;
  for (;;) {
    if (!GetFileInformationByHandleEx(directory, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, buffer, LIST_BOUND)) {
      ok = GetLastError() == ERROR_NO_MORE_FILES; break;
    }
    first = false; size_t offset = 0;
    for (;;) {
      if (++entries > 4096 || offset > LIST_BOUND - sizeof(FILE_ID_BOTH_DIR_INFO)) { ok = false; break; }
      FILE_ID_BOTH_DIR_INFO *entry = (FILE_ID_BOTH_DIR_INFO *)(buffer + offset);
      size_t head = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
      if (entry->FileNameLength % sizeof(wchar_t) || entry->FileNameLength > LIST_BOUND - offset - head) { ok = false; break; }
      char name[PATH_BOUND];
      int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, entry->FileName, (int)(entry->FileNameLength / sizeof(wchar_t)), name, PATH_BOUND - 1, NULL, NULL);
      if (count > 0) {
        name[count] = 0;
        if (!private_name(name) && !(entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
          bool is_directory = (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          HANDLE checked = open_relative(directory, name, is_directory);
          if (checked != BAD_HANDLE) {
            CloseHandle(checked);
            if (*used + (size_t)count + 2 > LIST_BOUND) { ok = false; break; }
            bytes[(*used)++] = is_directory ? 'D' : 'F';
            memcpy(bytes + *used, name, (size_t)count + 1); *used += (size_t)count + 1;
          }
        }
      }
      if (!entry->NextEntryOffset) break;
      if (entry->NextEntryOffset < head || entry->NextEntryOffset > LIST_BOUND - offset) { ok = false; break; }
      offset += entry->NextEntryOffset;
    }
    if (!ok) break;
  }
  free(buffer); return ok;
}

/* Rename/delete information classes and flags, declared locally so the layout
 * does not depend on the SDK's NTDDI_VERSION guards. POSIX semantics replace or
 * delete a name even while another handle (ours) holds the file.
 * Renames go through NtSetInformationFile with the parent directory HANDLE as
 * RootDirectory. kernel32's SetFileInformationByHandle(FileRenameInfoEx)
 * treats a relative FileName as a Win32 path against the process's current
 * directory, which would move the staged file outside the pinned root. */
#define BROKER_FILE_RENAME_INFORMATION_EX 65
#define BROKER_FILE_DISPOSITION_INFO_EX ((FILE_INFO_BY_HANDLE_CLASS)21)
#define BROKER_RENAME_REPLACE_IF_EXISTS 0x1
#define BROKER_RENAME_POSIX_SEMANTICS 0x2
#define BROKER_DISPOSITION_DELETE 0x1
#define BROKER_DISPOSITION_POSIX_SEMANTICS 0x2
typedef struct { ULONG Flags; HANDLE RootDirectory; ULONG FileNameLength; WCHAR FileName[1]; } broker_rename_info;
typedef NTSTATUS (NTAPI *broker_nt_set_information)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);

static bool same_file(HANDLE a, HANDLE b) {
  BY_HANDLE_FILE_INFORMATION x, y;
  return GetFileInformationByHandle(a, &x) && GetFileInformationByHandle(b, &y) &&
    x.dwVolumeSerialNumber == y.dwVolumeSerialNumber && x.nFileIndexHigh == y.nFileIndexHigh &&
    x.nFileIndexLow == y.nFileIndexLow && x.nNumberOfLinks == 1 && y.nNumberOfLinks == 1;
}

/* The name still resolves to the handle we checked, and holds the expected bytes. */
static bool target_unchanged(HANDLE directory, const wchar_t *leaf, HANDLE file, const char *expected, long old_size) {
  char *previous = NULL;
  size_t used = 0; LARGE_INTEGER zero = {0};
  bool ok = SetFilePointerEx(file, zero, NULL, FILE_BEGIN) && read_bytes(file, &previous, &used) &&
    used == (size_t)old_size && !memcmp(previous, expected, used);
  free(previous);
  if (!ok) return false;
  HANDLE again;
  if (nt_open(directory, leaf, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      BROKER_FILE_OPEN, BROKER_OPTIONS_FILE, &again) < 0) return false;
  ok = same_file(file, again); CloseHandle(again); return ok;
}

static bool name_absent(HANDLE directory, const wchar_t *leaf) {
  HANDLE probe;
  NTSTATUS status = nt_open(directory, leaf, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    BROKER_FILE_OPEN, 0, &probe);
  if (status >= 0) { CloseHandle(probe); return false; }
  return status == BROKER_STATUS_NOT_FOUND; /* Access denied and every other failure fail closed. */
}

static bool rename_in_place(HANDLE staged, HANDLE directory, const wchar_t *leaf, bool replace) {
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  broker_nt_set_information set = module ? (broker_nt_set_information)(void *)GetProcAddress(module, "NtSetInformationFile") : NULL;
  if (!set) return false;
  size_t length = wcslen(leaf);
  size_t size = offsetof(broker_rename_info, FileName) + (length + 1) * sizeof(wchar_t);
  broker_rename_info *info = calloc(1, size);
  if (!info) return false;
  info->Flags = BROKER_RENAME_POSIX_SEMANTICS | (replace ? BROKER_RENAME_REPLACE_IF_EXISTS : 0);
  info->RootDirectory = directory; /* the leaf resolves relative to the verified parent */
  info->FileNameLength = (ULONG)(length * sizeof(wchar_t));
  memcpy(info->FileName, leaf, length * sizeof(wchar_t));
  IO_STATUS_BLOCK io;
  bool ok = set(staged, &io, info, (ULONG)size, BROKER_FILE_RENAME_INFORMATION_EX) >= 0;
  free(info); return ok;
}

static bool delete_handle(HANDLE file) {
  DWORD flags = BROKER_DISPOSITION_DELETE | BROKER_DISPOSITION_POSIX_SEMANTICS;
  return SetFileInformationByHandle(file, BROKER_FILE_DISPOSITION_INFO_EX, &flags, sizeof flags) != 0;
}

/* Windows counterpart of the POSIX write_bytes contract: compare-and-swap
 * replace, create-only, and delete, relative to the pinned root, with a flushed
 * same-directory staging file. The byte-range lock is mandatory on Windows, so
 * other writers cannot change the target between comparison and commit. */
static bool write_bytes_windows(HANDLE root, const char *path, const char *expected, long old_size, const char *replacement, long new_size) {
  static unsigned temporary_sequence = 0;
  wchar_t wide[PATH_BOUND];
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, PATH_BOUND)) return false;
  wchar_t *slash = wcsrchr(wide, L'/');
  const wchar_t *leaf = slash ? slash + 1 : wide;
  if (slash) *slash = 0;
  if (!*leaf || !wcscmp(leaf, L".") || !wcscmp(leaf, L"..") || wcschr(leaf, L':') || wcschr(leaf, L'\\')) return false;
  HANDLE directory = BAD_HANDLE;
  if (slash) directory = descend_wide(root, wide, true, true);
  else if (!DuplicateHandle(GetCurrentProcess(), root, GetCurrentProcess(), &directory, 0, FALSE, DUPLICATE_SAME_ACCESS)) return false;
  if (directory == BAD_HANDLE) return false;
  bool ok = false, target_valid = false, locked = false;
  HANDLE file = BAD_HANDLE;
  if (old_size < 0) {
    target_valid = name_absent(directory, leaf);
  } else if (nt_open(directory, leaf, FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, BROKER_FILE_OPEN, BROKER_OPTIONS_FILE, &file) >= 0) {
    OVERLAPPED whole = {0};
    BY_HANDLE_FILE_INFORMATION info;
    locked = LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, MAXDWORD, MAXDWORD, &whole) != 0;
    target_valid = locked && safe_info(file, false, &info) && safe_long_name(file) &&
      target_unchanged(directory, leaf, file, expected, old_size);
  }
  if (target_valid && new_size < 0 && old_size >= 0) {
    ok = delete_handle(file);
  } else if (target_valid && new_size >= 0) {
    char narrow[96]; wchar_t temporary[96];
    int length = snprintf(narrow, sizeof narrow, ".canopy-write-%lu-%u", (unsigned long)GetCurrentProcessId(), ++temporary_sequence);
    HANDLE staged = BAD_HANDLE;
    if (length > 0 && (size_t)length < sizeof narrow && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, narrow, -1, temporary, 96) &&
        nt_open(directory, temporary, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE, 0 /* exclusive */,
          BROKER_FILE_CREATE, BROKER_OPTIONS_FILE, &staged) >= 0) {
      size_t written = 0;
      while (written < (size_t)new_size) {
        DWORD count = 0;
        if (!WriteFile(staged, replacement + written, (DWORD)((size_t)new_size - written), &count, NULL) || !count) break;
        written += count;
      }
      bool staged_ok = written == (size_t)new_size && FlushFileBuffers(staged);
      if (staged_ok)
        staged_ok = old_size >= 0 ? target_unchanged(directory, leaf, file, expected, old_size) : name_absent(directory, leaf);
      /* A create never replaces: a concurrent creator makes the rename fail. */
      if (staged_ok) ok = rename_in_place(staged, directory, leaf, old_size >= 0);
      if (!ok) delete_handle(staged);
      CloseHandle(staged);
    }
  }
  if (file != BAD_HANDLE) {
    if (locked) { OVERLAPPED whole = {0}; UnlockFileEx(file, 0, MAXDWORD, MAXDWORD, &whole); }
    CloseHandle(file);
  }
  CloseHandle(directory); return ok;
}
