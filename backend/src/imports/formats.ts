/** Single source of truth for the file formats: powers the UI guide, the sample files and the docs. */
export interface ColumnSpec {
  column: string;
  required: boolean;
  rule: string;
  example: string;
}

export interface FormatSpec {
  mode: 'create' | 'update';
  title: string;
  summary: string;
  columns: ColumnSpec[];
  notes: string[];
  sample: string;
  filename: string;
}

const CREATE_SAMPLE = `first_name,last_name,email,phone,company,tags
Ada,Lovelace,ada.lovelace@example.com,+1 415 555 0172,Analytical Engines,VIP;Lead
Grace,Hopper,grace.hopper@example.com,(212) 555-0199,US Navy,Customer
Alan,Turing,,,Bletchley Park,Prospect
`;

const UPDATE_SAMPLE = `email,first_name,last_name,phone,company,tags
ada.lovelace@example.com,,,+1 415 555 0100,Analytical Engines Ltd,Customer
grace.hopper@example.com,,,[clear],,VIP
`;

export const FORMATS: Record<'create' | 'update', FormatSpec> = {
  create: {
    mode: 'create',
    title: 'Add new contacts',
    summary: 'Creates one contact per row.',
    columns: [
      { column: 'first_name', required: true, rule: 'Up to 100 characters', example: 'Ada' },
      { column: 'last_name', required: true, rule: 'Up to 100 characters', example: 'Lovelace' },
      { column: 'email', required: false, rule: 'Valid email, unique among your contacts', example: 'ada@example.com' },
      { column: 'phone', required: false, rule: '7 to 15 digits; + ( ) - . and spaces allowed', example: '+1 415 555 0172' },
      { column: 'company', required: false, rule: 'Up to 150 characters', example: 'Analytical Engines' },
      { column: 'tags', required: false, rule: 'Separate several tags with a semicolon', example: 'VIP;Lead' },
    ],
    notes: [
      'Rows whose email already belongs to a contact are reported and skipped; nothing is overwritten.',
      'Rows with problems are skipped, and you can download them with the reason, fix them, and upload again.',
      'Header names are not case sensitive. Extra columns are ignored.',
    ],
    sample: CREATE_SAMPLE,
    filename: 'contacts-add-sample.csv',
  },
  update: {
    mode: 'update',
    title: 'Update existing contacts',
    summary: 'Finds each contact by email and changes only the columns you fill in.',
    columns: [
      { column: 'email', required: true, rule: 'Identifies the contact. It cannot be changed by import', example: 'ada@example.com' },
      { column: 'first_name', required: false, rule: 'Blank leaves it unchanged. Cannot be cleared', example: 'Ada' },
      { column: 'last_name', required: false, rule: 'Blank leaves it unchanged. Cannot be cleared', example: 'Lovelace' },
      { column: 'phone', required: false, rule: 'Blank leaves it unchanged; [clear] empties it', example: '[clear]' },
      { column: 'company', required: false, rule: 'Blank leaves it unchanged; [clear] empties it', example: 'Analytical Engines' },
      { column: 'tags', required: false, rule: 'Tags in the file are added. Import never removes tags', example: 'VIP;Customer' },
    ],
    notes: [
      'Include only the columns you want to change, plus email.',
      'A row is skipped if no active contact has that email, or if the contact is in the trash.',
      'Tip: use "Export CSV" on the Contacts page to get a file in this format, edit it, and upload it here.',
    ],
    sample: UPDATE_SAMPLE,
    filename: 'contacts-update-sample.csv',
  },
};
