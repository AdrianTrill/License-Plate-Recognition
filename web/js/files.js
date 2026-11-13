// Files the visitor dropped on the page, with those inside any folders among them.

// The files of a drop, in the order of their names (IMG_2 before IMG_10). A folder's entries must be taken while the
// drop is handled, so this is called from the drop event, and only then waits for the folders to be read.
export async function droppedFiles(dataTransfer) {
  const files = [...(dataTransfer?.files ?? [])];
  const entries = [...(dataTransfer?.items ?? [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((entry) => entry.isDirectory)) return files;
  const found = [];
  for (const entry of entries) await walk(entry, found);
  return found.sort(byName);
}

export function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

async function walk(entry, found) {
  if (entry.isFile) {
    found.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
  } else if (entry.isDirectory) {
    // A folder's entries come a hundred or so at a time, until an empty batch.
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, found);
    }
  }
}
