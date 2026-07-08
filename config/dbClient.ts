import pg from 'pg';
import { pool } from './db.js';


const TABLE_MAP: Record<string, string> = {
  'customers': 'customers_view',
  'customers_raw': 'customers',
  'contacts': 'contacts_view',
  'products': 'products'
};

class PgQueryBuilder {
  pool: pg.Pool;
  tableName: string;
  sqlTable: string;
  operation: string; // 'select', 'insert', 'update', 'delete'
  selectFields: string;
  insertData: any;
  updateData: any;
  wheres: any[];
  orders: any[];
  limitVal: number | null;
  isSingle: boolean;
  isMaybeSingle: boolean;
  params: any[];

  constructor(pool: pg.Pool, tableName: string) {
    this.pool = pool;
    this.tableName = tableName;
    this.sqlTable = TABLE_MAP[tableName] || tableName;
    this.operation = 'select';
    this.selectFields = '*';
    this.insertData = null;
    this.updateData = null;
    this.wheres = [];
    this.orders = [];
    this.limitVal = null;
    this.isSingle = false;
    this.isMaybeSingle = false;
    this.params = [];
  }

  select(fields = '*') {
    this.selectFields = fields;
    return this;
  }

  insert(data: any) {
    this.operation = 'insert';
    this.insertData = data;
    return this;
  }

  update(data: any) {
    this.operation = 'update';
    this.updateData = data;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(col: string, val: any) {
    this.wheres.push({ type: 'eq', col, val });
    return this;
  }

  neq(col: string, val: any) {
    this.wheres.push({ type: 'neq', col, val });
    return this;
  }

  in(col: string, valArray: any[]) {
    this.wheres.push({ type: 'in', col, val: valArray });
    return this;
  }

  gte(col: string, val: any) {
    this.wheres.push({ type: 'gte', col, val });
    return this;
  }

  gt(col: string, val: any) {
    this.wheres.push({ type: 'gt', col, val });
    return this;
  }

  lte(col: string, val: any) {
    this.wheres.push({ type: 'lte', col, val });
    return this;
  }

  lt(col: string, val: any) {
    this.wheres.push({ type: 'lt', col, val });
    return this;
  }

  ilike(col: string, val: string) {
    this.wheres.push({ type: 'ilike', col, val });
    return this;
  }

  or(orConditionStr: string) {
    this.wheres.push({ type: 'or', val: orConditionStr });
    return this;
  }

  not(col: string, op: string, val: any) {
    this.wheres.push({ type: 'not', col, op, val });
    return this;
  }

  order(col: string, { ascending = true } = {}) {
    this.orders.push({ col, direction: ascending ? 'ASC' : 'DESC' });
    return this;
  }

  limit(val: number) {
    this.limitVal = val;
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  maybeSingle() {
    this.isMaybeSingle = true;
    return this;
  }

  async execute(): Promise<{ data: any; error: Error | null }> {
    let sql = 'not built yet';
    try {
      // Translate branch_code to branch for salesperson and customers under the hood
      if (this.tableName === 'salesperson' || this.tableName === 'customers' || this.tableName === 'customers_raw') {
        for (const w of this.wheres) {
          if (w.col === 'branch_code') {
            w.col = 'branch';
          }
        }
        for (const o of this.orders) {
          if (o.col === 'branch_code') {
            o.col = 'branch';
          }
        }
        if (this.selectFields !== '*') {
          this.selectFields = this.selectFields
            .split(',')
            .map(f => {
              const trimmed = f.trim();
              if (trimmed === 'branch_code') return 'branch';
              return trimmed;
            })
            .join(', ');
        }
        if (this.updateData && this.updateData.branch_code !== undefined) {
          this.updateData.branch = this.updateData.branch_code;
          delete this.updateData.branch_code;
        }
        if (this.insertData) {
          const rows = Array.isArray(this.insertData) ? this.insertData : [this.insertData];
          for (const row of rows) {
            if (row.branch_code !== undefined) {
              row.branch = row.branch_code;
              delete row.branch_code;
            }
          }
        }
      }

      // Translate columns for products table query under the hood
      if (this.tableName === 'products') {
        const productMapping: Record<string, string> = {
          'id': 'product_template_id',
          'code': 'model',
          'price': 'sales_price',
          'stock': 'actual_quantity',
          'category': 'product_sub_category'
        };

        for (const w of this.wheres) {
          if (productMapping[w.col]) {
            w.col = productMapping[w.col];
          }
        }
        for (const o of this.orders) {
          if (productMapping[o.col]) {
            o.col = productMapping[o.col];
          }
        }
        if (this.selectFields !== '*') {
          this.selectFields = this.selectFields
            .split(',')
            .map(f => {
              const trimmed = f.trim();
              if (productMapping[trimmed]) return productMapping[trimmed];
              return trimmed;
            })
            .join(', ');
        }
      }

      // Translate join where fields for contacts table
      if (this.tableName === 'contacts' && this.selectFields.includes('customers!inner')) {
        for (const w of this.wheres) {
          if (w.col === 'customers.branch_code') {
            w.col = 'cust"."branch';
          } else if (w.col === 'customers.salesperson') {
            w.col = 'cust"."salesperson';
          } else if (w.col === 'name') {
            w.col = 'c"."name';
          }
        }
      }

      sql = '';
      this.params = [];
      const wheresSql: string[] = [];

      // Build Whers
      for (const w of this.wheres) {
        if (w.type === 'eq') {
          this.params.push(w.val);
          wheresSql.push(`"${w.col}" = $${this.params.length}`);
        } else if (w.type === 'neq') {
          this.params.push(w.val);
          wheresSql.push(`"${w.col}" != $${this.params.length}`);
        } else if (w.type === 'gte') {
          this.params.push(w.val);
          wheresSql.push(`"${w.col}" >= $${this.params.length}`);
        } else if (w.type === 'gt') {
          this.params.push(w.val);
          wheresSql.push(`"${w.col}" > $${this.params.length}`);
        } else if (w.type === 'lte') {
          this.params.push(w.val);
          wheresSql.push(`"${w.col}" <= $${this.params.length}`);
        } else if (w.type === 'lt') {
          this.params.push(w.val);
          wheresSql.push(`"${w.col}" < $${this.params.length}`);
        } else if (w.type === 'ilike') {
          this.params.push(w.val);
          wheresSql.push(`"${w.col}" ILIKE $${this.params.length}`);
        } else if (w.type === 'in') {
          const placeholders = w.val.map((val: any) => {
            this.params.push(val);
            return `$${this.params.length}`;
          });
          wheresSql.push(`"${w.col}" IN (${placeholders.join(', ')})`);
        } else if (w.type === 'not') {
          if (w.op === 'is' && w.val === null) {
            wheresSql.push(`"${w.col}" IS NOT NULL`);
          } else {
            this.params.push(w.val);
            wheresSql.push(`"${w.col}" != $${this.params.length}`);
          }
        } else if (w.type === 'or') {
          const parts = w.val.split(',');
          const subConditions: string[] = [];
          for (const part of parts) {
            const match = part.match(/^([^.]+)\.([^.]+)\.(.+)$/);
            if (match) {
              let col = match[1].trim();
              const op = match[2].trim();
              let val = match[3].trim();
              if (val.startsWith('"') && val.endsWith('"')) {
                val = val.slice(1, -1);
              }
              if (this.tableName === 'products') {
                const productMapping: Record<string, string> = {
                  'id': 'product_template_id',
                  'code': 'model',
                  'price': 'sales_price',
                  'stock': 'actual_quantity',
                  'category': 'product_sub_category'
                };
                if (productMapping[col]) {
                  col = productMapping[col];
                }
              }
              if (op === 'ilike') {
                this.params.push(val);
                subConditions.push(`"${col}" ILIKE $${this.params.length}`);
              } else if (op === 'eq') {
                this.params.push(val);
                subConditions.push(`"${col}" = $${this.params.length}`);
              }
            }
          }
          if (subConditions.length > 0) {
            wheresSql.push(`(${subConditions.join(' OR ')})`);
          }
        }
      }

      const whereClause = wheresSql.length > 0 ? `WHERE ${wheresSql.join(' AND ')}` : '';

      if (this.operation === 'select') {
        if (this.tableName === 'contacts' && this.selectFields.includes('customers!inner')) {
          sql = `
            SELECT 
              c.name, c.customer_id, 
              cust.id AS "customers.id", 
              cust.display_name AS "customers.display_name", 
              cust.salesperson AS "customers.salesperson", 
              cust.branch AS "customers.branch_code"
            FROM contacts_view c
            INNER JOIN customers_view cust ON c.customer_id = cust.id
            ${whereClause}
          `;
        } else {
          let cols = this.selectFields;
          if (cols === '*') {
            cols = '*';
          } else {
            cols = cols.split(',').map(c => `"${c.trim()}"`).join(', ');
          }
          sql = `SELECT ${cols} FROM ${this.sqlTable} ${whereClause}`;
        }

        if (this.orders.length > 0) {
          const orderClauses = this.orders.map(o => `"${o.col}" ${o.direction}`);
          sql += ` ORDER BY ${orderClauses.join(', ')}`;
        }

        if (this.limitVal !== null) {
          sql += ` LIMIT ${this.limitVal}`;
        }
      } else if (this.operation === 'insert') {
        const data = Array.isArray(this.insertData) ? this.insertData : [this.insertData];
        if (data.length === 0) {
          return { data: [], error: null };
        }

        const keys = Object.keys(data[0]);
        const columns = keys.map(k => `"${k}"`).join(', ');

        const valueRows = [];
        for (const row of data) {
          const placeholders = keys.map(k => {
            let val = row[k];
            if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
              val = JSON.stringify(val);
            }
            this.params.push(val);
            return `$${this.params.length}`;
          });
          valueRows.push(`(${placeholders.join(', ')})`);
        }

        sql = `INSERT INTO ${this.sqlTable} (${columns}) VALUES ${valueRows.join(', ')} RETURNING *`;
      } else if (this.operation === 'update') {
        const keys = Object.keys(this.updateData);
        const setClauses = keys.map(k => {
          let val = this.updateData[k];
          if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
            val = JSON.stringify(val);
          }
          this.params.push(val);
          return `"${k}" = $${this.params.length}`;
        });

        sql = `UPDATE ${this.sqlTable} SET ${setClauses.join(', ')} ${whereClause} RETURNING *`;
      } else if (this.operation === 'delete') {
        sql = `DELETE FROM ${this.sqlTable} ${whereClause} RETURNING *`;
      }

      const result = await this.pool.query(sql, this.params);
      let returnedData = result.rows;

      if (returnedData) {
        if (this.tableName === 'salesperson' || this.tableName === 'customers' || this.tableName === 'customers_raw') {
          returnedData = returnedData.map(row => {
            if (row.branch !== undefined && row.branch_code === undefined) {
              return { ...row, branch_code: row.branch };
            }
            return row;
          });
        } else if (this.tableName === 'products') {
          returnedData = returnedData.map(row => {
            const mappedRow: any = { ...row };
            if (row.product_template_id !== undefined) mappedRow.id = row.product_template_id;
            if (row.model !== undefined) mappedRow.code = row.model;
            if (row.sales_price !== undefined) mappedRow.price = row.sales_price;
            if (row.actual_quantity !== undefined) mappedRow.stock = row.actual_quantity;
            if (row.product_sub_category !== undefined) mappedRow.category = row.product_sub_category;
            return mappedRow;
          });
        }
      }

      if (this.tableName === 'contacts' && this.selectFields.includes('customers!inner')) {
        returnedData = returnedData.map(row => {
          return {
            name: row.name,
            customer_id: row.customer_id,
            customers: {
              id: row["customers.id"],
              display_name: row["customers.display_name"],
              salesperson: row["customers.salesperson"],
              branch_code: row["customers.branch_code"]
            }
          };
        });
      }

      if (this.isSingle || this.isMaybeSingle) {
        if (returnedData.length === 0) {
          return { data: null, error: this.isSingle ? new Error("No rows found") : null };
        }
        return { data: returnedData[0], error: null };
      }

      return { data: returnedData, error: null };
    } catch (err: any) {
      console.error("SQL Error executing query builder:", err.message, "SQL:", sql);
      return { data: null, error: err };
    }
  }

  then(resolve: (value: { data: any; error: Error | null }) => void, reject?: (reason: any) => void) {
    return this.execute().then(resolve, reject);
  }
}

export const dbClient = {
  from(tableName: string) {
    if (tableName === 'salespeople') {
      return {
        select: (fields = '*') => {
          return {
            then: async (resolve: (value: { data: any; error: Error | null }) => void) => {
              try {
                const result = await pool.query(`
                  SELECT DISTINCT ON (salesperson) 
                      salesperson AS name, 
                      salesperson_id, 
                      salesperson_phone AS phone,
                      COALESCE(customer_sale_area, sales_team) AS branch
                  FROM sale_orders 
                  WHERE salesperson IS NOT NULL AND salesperson != '' AND salesperson_id IS NOT NULL
                  ORDER BY salesperson, order_date DESC;
                `);
                
                // Clean names and deduplicate
                const seen = new Map();
                for (const row of result.rows) {
                  // Strip (PM), (THT), or any parenthesised suffix at the end
                  const cleanName = row.name.replace(/\s*\([^)]*\)\s*$/gi, '').trim();

                  let cleanPhone = null;
                  if (row.phone && row.phone !== 'null') {
                    cleanPhone = row.phone.trim();
                  }

                  // Keep first occurrence per cleaned name (DISTINCT ON salesperson + ORDER BY order_date DESC
                  // already gives us the most-recent record per raw name, so first-seen = most recent)
                  if (!seen.has(cleanName)) {
                    seen.set(cleanName, {
                      name: cleanName,
                      salesperson_id: row.salesperson_id ? String(row.salesperson_id) : null,
                      phone: cleanPhone,
                      branch: row.branch || null
                    });
                  }
                }

                const formatted = Array.from(seen.values())
                  .sort((a: any, b: any) => a.name.localeCompare(b.name, 'th'));

                resolve({ data: formatted, error: null });
              } catch (err: any) {
                console.error("Error in dbClient salespeople select:", err);
                resolve({ data: null, error: err });
              }
            }
          };
        }
      };
    }

    if (tableName === 'branch') {
      return {
        select: (fields = '*') => {
          const staticBranches = [
            { branch: 'สมุทรปราการ' },
            { branch: 'พระราม 2' },
            { branch: 'ปทุมธานี' },
            { branch: 'ชลบุรี' },
            { branch: 'ภาคใต้' },
            { branch: 'ภาคอีสาน' },
            { branch: 'ต่างประเทศ' },
            { branch: 'ภาคเหนือ' },
            { branch: 'ภาคตะวันออก' },
            { branch: 'Product Specialist' },
            { branch: 'PLC' },
            { branch: 'Sales' },
            { branch: 'Service' },
            { branch: 'Healthcare' },
            { branch: 'Marketing' }
          ];
          
          return {
            in: (col: string, vals: any[]) => {
              const lookupCol = (col === 'branch_code') ? 'branch' : col;
              const filtered = staticBranches.filter(b => vals.includes(b[lookupCol as keyof typeof b]));
              const mapped = filtered.map(b => ({
                branch: b.branch,
                branch_code: b.branch,
                name: b.branch
              }));
              return Promise.resolve({ data: mapped, error: null });
            },
            then: (resolve: (value: { data: any; error: Error | null }) => void) => {
              const mapped = staticBranches.map(b => ({
                branch: b.branch,
                branch_code: b.branch,
                name: b.branch
              }));
              return resolve({ data: mapped, error: null });
            }
          };
        }
      };
    }

    return new PgQueryBuilder(pool, tableName);
  }
};

// --- Query สาขาทั้งหมดจาก COALESCE(customer_sale_area, sales_team) ---
export async function getBranches() {
  const result = await pool.query(`
    SELECT DISTINCT COALESCE(customer_sale_area, sales_team) AS branch
    FROM sale_orders
    WHERE COALESCE(customer_sale_area, sales_team) IS NOT NULL
      AND COALESCE(customer_sale_area, sales_team) != ''
    ORDER BY branch
  `);
  return result.rows.map((r, i) => ({ index: i + 1, name: r.branch }));
}
