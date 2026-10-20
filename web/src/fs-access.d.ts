// Type declarations for the parts of the File System Access API that are not
// yet in lib.dom.d.ts. Browser-only glue; nothing here is imported at runtime.
interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string | FileSystemHandle;
}

declare function showDirectoryPicker(
  options?: DirectoryPickerOptions,
): Promise<FileSystemDirectoryHandle>;
