import { BadRequestException, Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { extname } from 'node:path';
import { readSheet } from 'read-excel-file/node';

export type RawOrderRow = Record<string, string>;

export interface ParsedOrderFile {
  headers: string[];
  rows: RawOrderRow[];
}

@Injectable()
export class OrderFileParser {
  assertSupported(fileName: string): void {
    const extension = extname(fileName).toLowerCase();
    if (extension !== '.csv' && extension !== '.xlsx') {
      throw new BadRequestException('仅支持 CSV 或 XLSX 格式');
    }
  }

  async parse(file: Express.Multer.File): Promise<ParsedOrderFile> {
    const extension = extname(file.originalname).toLowerCase();

    if (extension === '.csv') {
      return this.parseCsv(file.buffer);
    }

    if (extension === '.xlsx') {
      return this.parseExcel(file.buffer);
    }

    throw new BadRequestException('仅支持 CSV 或 XLSX 格式');
  }

  private parseCsv(buffer: Buffer): ParsedOrderFile {
    const rows = parse(buffer, {
      bom: true,
      columns: (headers: string[]) => headers.map((header) => header.trim()),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as RawOrderRow[];

    return {
      headers: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows: rows.map((row) => this.stringifyRow(row)),
    };
  }

  private async parseExcel(buffer: Buffer): Promise<ParsedOrderFile> {
    const sheet = await readSheet<string>(buffer, {
      parseNumber: (value) => value,
      trim: true,
    });

    if (sheet.length === 0) {
      return { headers: [], rows: [] };
    }

    const headers = sheet[0].map((cell) => this.stringifyCell(cell).trim());
    const rows = sheet.slice(1).map((cells) => {
      const row: RawOrderRow = {};
      headers.forEach((header, index) => {
        if (header) {
          row[header] = this.stringifyCell(cells[index]);
        }
      });
      return row;
    });

    return { headers, rows };
  }

  private stringifyRow(row: Record<string, unknown>): RawOrderRow {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.trim(), this.stringifyCell(value)]),
    );
  }

  private stringifyCell(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value).trim();
  }
}
