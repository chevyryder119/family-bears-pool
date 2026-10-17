// db.js - create and seed squares table (run `npm run seed`)
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pool.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS squares (
      id INTEGER PRIMARY KEY,
      row INTEGER,
      col INTEGER,
      owner_name TEXT,
      owner_email TEXT,
      purchased INTEGER DEFAULT 0,
      stripe_payment_intent TEXT,
      purchased_at TEXT
    )
  `);

  db.get('SELECT COUNT(*) as cnt FROM squares', (err, row) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    if (row.cnt === 25) {
      console.log('Already seeded 25 squares.');
      db.close();
      return;
    }

    db.run('DELETE FROM squares', () => {
      const stmt = db.prepare('INSERT INTO squares (id, row, col) VALUES (?, ?, ?)');
      let id = 1;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          stmt.run(id, r, c);
          id++;
        }
      }
      stmt.finalize(() => {
        console.log('Seeded 25 squares.');
        db.close();
      });
    });
  });
});
