# AliyunDriveBackup

This folder is for large files that are better backed up to Aliyun Drive instead of GitHub.

Recommended use:

- `large-files/`: big files that do not fit well in Git, such as installers, large PDFs, datasets, and asset packs.
- `media/`: videos, audio files, screenshots, and image collections.
- `exports/`: exported files from apps, generated deliverables, and final output packages.
- `archives/`: zip, tar, dmg, and other compressed backup packages.
- `documents/`: Word, Excel, PPT, notes, and other personal documents.

Suggested workflow:

1. Put large files into the right folder here.
2. Run `auto_backup_large_files.command`, or let the automatic sync task run.
3. Keep code and small text files in GitHub; keep big files in Aliyun Drive.
4. Git only tracks this folder structure and sync scripts. Files placed in the category folders are ignored by Git and uploaded to Aliyun Drive.

Automatic large-file rule:

- Files generated under `work/` or `outputs/` that are 50 MB or larger are moved here automatically.
- Archives go to `archives/`.
- Media files go to `media/`.
- Documents go to `documents/`.
- Other large files go to `large-files/`.
