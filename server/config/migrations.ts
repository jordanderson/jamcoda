import type Database from 'better-sqlite3';

interface Migration {
  id: string;
  description: string;
  up: (db: Database.Database) => void;
}

interface MigrationResult {
  appliedIds: string[];
  totalMigrations: number;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

const migrations: Migration[] = [
  {
    id: '001-initial-schema',
    description: 'Create initial schema for first public release',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          jamcorder_path TEXT NOT NULL UNIQUE,
          local_path TEXT NOT NULL,
          filename TEXT NOT NULL,
          file_size INTEGER,
          jamcorder_modified INTEGER,
          synced_at INTEGER NOT NULL,
          date_recorded TEXT NOT NULL,
          is_complete INTEGER NOT NULL DEFAULT 0,
          completed_at INTEGER,
          midi_duration REAL
        );

        CREATE INDEX IF NOT EXISTS idx_date_recorded ON files(date_recorded);
        CREATE INDEX IF NOT EXISTS idx_jamcorder_path ON files(jamcorder_path);

        CREATE TABLE IF NOT EXISTS annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL,
          song_name TEXT NOT NULL,
          start_time REAL NOT NULL,
          end_time REAL NOT NULL,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_file_id ON annotations(file_id);

        CREATE TABLE IF NOT EXISTS prediction_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL,
          predicted_song_name TEXT NOT NULL,
          predicted_start_time REAL NOT NULL,
          predicted_end_time REAL NOT NULL,
          predicted_confidence REAL,
          status TEXT NOT NULL DEFAULT 'unsure',
          reviewed_song_name TEXT,
          reviewed_start_time REAL,
          reviewed_end_time REAL,
          review_notes TEXT,
          model_version TEXT,
          promoted_annotation_id INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          reviewed_at INTEGER,
          promoted_at INTEGER,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
          FOREIGN KEY (promoted_annotation_id) REFERENCES annotations(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_prediction_reviews_file_id ON prediction_reviews(file_id);
        CREATE INDEX IF NOT EXISTS idx_prediction_reviews_status ON prediction_reviews(status);
        CREATE INDEX IF NOT EXISTS idx_prediction_reviews_created_at ON prediction_reviews(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_prediction_reviews_promoted ON prediction_reviews(promoted_annotation_id);

        CREATE TABLE IF NOT EXISTS ignored_sections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL,
          start_time REAL NOT NULL,
          end_time REAL NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ignored_sections_file_id ON ignored_sections(file_id);
        CREATE INDEX IF NOT EXISTS idx_ignored_sections_time ON ignored_sections(file_id, start_time, end_time);

        CREATE TABLE IF NOT EXISTS sync_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_sync_at INTEGER,
          last_sync_file_count INTEGER DEFAULT 0
        );

        INSERT OR IGNORE INTO sync_metadata (id, last_sync_file_count) VALUES (1, 0);
      `);
    }
  }
];

export function runMigrations(db: Database.Database): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));
  const appliedIds: string[] = [];

  const insertApplied = db.prepare(`
    INSERT INTO schema_migrations (id, description, applied_at)
    VALUES (?, ?, ?)
  `);

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    const tx = db.transaction(() => {
      migration.up(db);
      insertApplied.run(migration.id, migration.description, nowUnix());
    });
    tx();
    appliedIds.push(migration.id);
  }

  return {
    appliedIds,
    totalMigrations: migrations.length
  };
}
