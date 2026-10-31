import sqlite3 from "sqlite3";
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';

const dbPath = join(__dirname, '../healthcare.db');
const sqlite = sqlite3.verbose();

// Delete existing DB to start fresh
if (existsSync(dbPath)) {
  unlinkSync(dbPath);
}

const db = new sqlite.Database(dbPath);

db.serialize(() => {
  console.log('Creating convoluted healthcare tables...');

  // 1. Reference Table for Blood Types
  db.run(`
    CREATE TABLE REF_BLD_TYP (
      BLD_TYP_CD_REF TEXT PRIMARY KEY,
      BLD_TYP_DESC_TXT TEXT NOT NULL,
      IS_UNIV_DNR_FLG INTEGER DEFAULT 0
    )
  `);

  // 2. Patient Demographics
  db.run(`
    CREATE TABLE TBL_PT_DEMO_01 (
      SYS_PT_ID INTEGER PRIMARY KEY AUTOINCREMENT,
      PT_F_NME_TXT TEXT,
      PT_L_NME_TXT TEXT,
      PT_DOB_DT TEXT,
      BLD_TYP_CD_REF TEXT,
      PT_GENDER_CD TEXT,
      ACTV_FLG INTEGER DEFAULT 1,
      FOREIGN KEY(BLD_TYP_CD_REF) REFERENCES REF_BLD_TYP(BLD_TYP_CD_REF)
    )
  `);

  // 3. Provider Master List
  db.run(`
    CREATE TABLE TBL_PRV_MASTER (
      SYS_PRV_ID INTEGER PRIMARY KEY AUTOINCREMENT,
      PRV_NPI_NUM TEXT UNIQUE,
      PRV_F_NME TEXT,
      PRV_L_NME TEXT,
      PRV_SPEC_CD TEXT
    )
  `);

  // 4. Clinical Encounters (Appointments)
  db.run(`
    CREATE TABLE TBL_ENC_CLINICAL_99 (
      SYS_ENC_ID INTEGER PRIMARY KEY AUTOINCREMENT,
      SYS_PT_ID_REF INTEGER,
      SYS_PRV_ID_REF INTEGER,
      ENC_DT_TM TEXT,
      CHIEF_COMPLAINT_TXT TEXT,
      DX_ICD10_CD TEXT,
      ENC_STAT_CD TEXT,
      FOREIGN KEY(SYS_PT_ID_REF) REFERENCES TBL_PT_DEMO_01(SYS_PT_ID),
      FOREIGN KEY(SYS_PRV_ID_REF) REFERENCES TBL_PRV_MASTER(SYS_PRV_ID)
    )
  `);

  // 5. Billing and Claims
  db.run(`
    CREATE TABLE TBL_CLM_FIN_DTL (
      SYS_CLM_ID INTEGER PRIMARY KEY AUTOINCREMENT,
      SYS_ENC_ID_REF INTEGER,
      TOT_CHG_AMT REAL,
      PT_RESP_AMT REAL,
      CLM_STAT_CD TEXT,
      FOREIGN KEY(SYS_ENC_ID_REF) REFERENCES TBL_ENC_CLINICAL_99(SYS_ENC_ID)
    )
  `);

  // 6. Encounter Vitals
  db.run(`
    CREATE TABLE TBL_ENC_VITALS (
      SYS_VTL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
      SYS_ENC_ID_REF INTEGER,
      HEIGHT_INCHES REAL,
      WEIGHT_LBS REAL,
      BP_SYSTOLIC INTEGER,
      BP_DIASTOLIC INTEGER,
      BMI REAL,
      FOREIGN KEY(SYS_ENC_ID_REF) REFERENCES TBL_ENC_CLINICAL_99(SYS_ENC_ID)
    )
  `);

  // 7. Patient Allergies
  db.run(`
    CREATE TABLE TBL_PT_ALLERGIES (
      SYS_ALGY_ID INTEGER PRIMARY KEY AUTOINCREMENT,
      SYS_PT_ID_REF INTEGER,
      ALLERGEN_TXT TEXT,
      REACTION_TXT TEXT,
      SEVERITY_CD TEXT,
      FOREIGN KEY(SYS_PT_ID_REF) REFERENCES TBL_PT_DEMO_01(SYS_PT_ID)
    )
  `);

  // 8. Patient Medications
  db.run(`
    CREATE TABLE TBL_PT_MEDICATIONS (
      SYS_MED_ID INTEGER PRIMARY KEY AUTOINCREMENT,
      SYS_PT_ID_REF INTEGER,
      MED_NAME_TXT TEXT,
      DOSAGE_TXT TEXT,
      FREQUENCY_TXT TEXT,
      IS_ACTIVE_FLG INTEGER,
      FOREIGN KEY(SYS_PT_ID_REF) REFERENCES TBL_PT_DEMO_01(SYS_PT_ID)
    )
  `);

  console.log('Inserting convoluted mock data (now with thousands of rows and dirty data)...');

  // Insert Blood Types
  const stmtBlood = db.prepare(`INSERT INTO REF_BLD_TYP VALUES (?, ?, ?)`);
  const bloodTypes = [
    ['A_POS', 'A Positive', 0], ['A_NEG', 'A Negative', 0],
    ['B_POS', 'B Positive', 0], ['B_NEG', 'B Negative', 0],
    ['AB_POS', 'AB Positive', 0], ['AB_NEG', 'AB Negative', 0],
    ['O_POS', 'O Positive', 0], ['O_NEG', 'O Negative', 1]
  ];
  bloodTypes.forEach(bt => stmtBlood.run(bt));
  stmtBlood.run('UNKNOWN', 'Unknown Blood Type', 0);
  stmtBlood.finalize();

  // Helper for Randomization
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randElem = (arr) => arr[randInt(0, arr.length - 1)];

  // Insert Patients (1000)
  const firstNames = ['James', 'Emma', 'Michael', 'Olivia', 'William', 'Sophia', 'Alexander', 'Isabella', 'John', 'Jane', 'Robert', 'Mary', 'David', 'Patricia', 'Richard', 'Jennifer', 'Joseph', 'Linda', 'Thomas', 'Elizabeth'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];
  const genders = ['M', 'F', 'U'];
  
  const stmtPt = db.prepare(`INSERT INTO TBL_PT_DEMO_01 (PT_F_NME_TXT, PT_L_NME_TXT, PT_DOB_DT, BLD_TYP_CD_REF, PT_GENDER_CD) VALUES (?, ?, ?, ?, ?)`);
  
  for (let i = 1; i <= 1000; i++) {
    const fName = randElem(firstNames);
    let lName = randElem(lastNames);
    let dob = `${randInt(1940, 2020)}-${String(randInt(1, 12)).padStart(2, '0')}-${String(randInt(1, 28)).padStart(2, '0')}`;
    let bldType = randElem(bloodTypes)[0];
    let gender = randElem(genders);

    // Inject some dirty data periodically
    if (i % 50 === 0) gender = randElem(['Male', 'Female', '?', '   M', 'F   ']); 
    if (i % 75 === 0) dob = `${String(randInt(1, 12)).padStart(2, '0')}/${String(randInt(1, 28)).padStart(2, '0')}/${randInt(1940, 2020)}`; 
    if (i % 100 === 0) bldType = 'UNKNOWN'; 
    if (i % 125 === 0) lName = lName.toLowerCase(); 
    if (i % 150 === 0) dob = null; 

    stmtPt.run(fName, lName, dob, bldType, gender);
  }
  stmtPt.finalize();

  // Insert Allergies and Medications
  const stmtAlgy = db.prepare(`INSERT INTO TBL_PT_ALLERGIES (SYS_PT_ID_REF, ALLERGEN_TXT, REACTION_TXT, SEVERITY_CD) VALUES (?, ?, ?, ?)`);
  const stmtMed = db.prepare(`INSERT INTO TBL_PT_MEDICATIONS (SYS_PT_ID_REF, MED_NAME_TXT, DOSAGE_TXT, FREQUENCY_TXT, IS_ACTIVE_FLG) VALUES (?, ?, ?, ?, ?)`);
  
  const allergens = ['Penicillin', 'Peanuts', 'Latex', 'Aspirin', 'Sulfa Drugs', 'Pollen', 'Dust Mites'];
  const reactions = ['Hives', 'Anaphylaxis', 'Rash', 'Shortness of breath', 'Swelling'];
  const severities = ['MILD', 'MODERATE', 'SEVERE'];

  const meds = ['Lisinopril', 'Levothyroxine', 'Atorvastatin', 'Metformin', 'Amlodipine', 'Metoprolol', 'Omeprazole', 'Simvastatin', 'Losartan', 'Albuterol'];
  const dosages = ['10mg', '20mg', '50mg', '100mcg', '5mg', '2 inhalations'];
  const frequencies = ['Daily', 'Twice daily', 'As needed', 'Weekly', 'Every 8 hours'];

  for (let i = 1; i <= 1000; i++) {
    // 30% chance to have an allergy
    if (Math.random() < 0.3) {
      let severity = randElem(severities);
      if (i % 210 === 0) severity = 'super bad'; // dirty data
      stmtAlgy.run(i, randElem(allergens), randElem(reactions), severity);
    }
    
    // 50% chance to have 1-3 medications
    if (Math.random() < 0.5) {
      const numMeds = randInt(1, 3);
      for (let j = 0; j < numMeds; j++) {
        let dose = randElem(dosages);
        if (i % 310 === 0) dose = 'lots'; // dirty data
        stmtMed.run(i, randElem(meds), dose, randElem(frequencies), randElem([0, 1]));
      }
    }
  }
  stmtAlgy.finalize();
  stmtMed.finalize();

  // Insert Providers (50)
  const providerFirsts = ['Gregory', 'Lisa', 'James', 'Allison', 'John', 'Perry', 'Christopher', 'Elliot', 'Robert', 'Meredith', 'Cristina', 'Alex', 'Isobel', 'George', 'Miranda', 'Derek'];
  const providerLasts = ['House', 'Cuddy', 'Wilson', 'Cameron', 'Dorian', 'Cox', 'Turk', 'Reid', 'Kelso', 'Grey', 'Yang', 'Karev', 'Stevens', 'OMalley', 'Bailey', 'Shepherd'];
  const specialties = ['DIAGNOSTICS', 'ENDOCRINOLOGY', 'ONCOLOGY', 'IMMUNOLOGY', 'SURGERY', 'PEDIATRICS', 'CARDIOLOGY', 'NEUROLOGY', 'GENERAL_PRACTICE'];
  
  const stmtPrv = db.prepare(`INSERT INTO TBL_PRV_MASTER (PRV_NPI_NUM, PRV_F_NME, PRV_L_NME, PRV_SPEC_CD) VALUES (?, ?, ?, ?)`);
  
  for (let i = 1; i <= 50; i++) {
    let npi = `1${String(i).padStart(9, '0')}`;
    let spec = randElem(specialties);

    // Dirty data
    if (i === 15) npi = null; 
    if (i === 30) spec = 'unknown_spec'; 

    stmtPrv.run(npi, randElem(providerFirsts), randElem(providerLasts), spec);
  }
  stmtPrv.finalize();

  // Insert Encounters and Vitals (5000)
  const complaints = [
    { text: 'Routine checkup', icd: 'Z00.00' },
    { text: 'Fatigue', icd: 'R53.83' },
    { text: 'Follow up on lab results', icd: 'Z09' },
    { text: 'Allergic reaction', icd: 'T78.40XA' },
    { text: 'Unexplained leg pain', icd: 'M79.609' },
    { text: 'Diabetes management', icd: 'E11.9' },
    { text: 'Chemotherapy session', icd: 'Z51.11' },
    { text: 'Asthma exacerbation', icd: 'J45.901' },
    { text: 'Persistent cough', icd: 'R05.1' },
    { text: 'Fever', icd: 'R50.9' },
    { text: 'Head trauma', icd: 'S06.0X0A' },
    { text: 'Nausea', icd: 'R11.2' },
    { text: 'Dizziness', icd: 'R42' },
    { text: 'Shortness of breath', icd: 'R06.02' }
  ];
  const encStatuses = ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'SCHEDULED'];
  
  const stmtEnc = db.prepare(`INSERT INTO TBL_ENC_CLINICAL_99 (SYS_PT_ID_REF, SYS_PRV_ID_REF, ENC_DT_TM, CHIEF_COMPLAINT_TXT, DX_ICD10_CD, ENC_STAT_CD) VALUES (?, ?, ?, ?, ?, ?)`);
  const stmtVtl = db.prepare(`INSERT INTO TBL_ENC_VITALS (SYS_ENC_ID_REF, HEIGHT_INCHES, WEIGHT_LBS, BP_SYSTOLIC, BP_DIASTOLIC, BMI) VALUES (?, ?, ?, ?, ?, ?)`);
  
  let currentEncounterId = 1;
  const validClaims = [];

  for (let i = 1; i <= 5000; i++) {
    const ptId = randInt(1, 1000);
    const prvId = randInt(1, 50);
    
    // Generate dates between 2022 and 2024
    let date = `${randInt(2022, 2024)}-${String(randInt(1, 12)).padStart(2, '0')}-${String(randInt(1, 28)).padStart(2, '0')} ${String(randInt(8, 17)).padStart(2, '0')}:${randElem(['00', '15', '30', '45'])}:00`;
    const complaintObj = randElem(complaints);
    let icd = complaintObj.icd;
    let stat = randElem(encStatuses);

    // Dirty data
    if (i % 200 === 0) stat = stat.toLowerCase(); 
    if (i % 300 === 0) stat = '  COMPLETED  '; 
    if (i % 400 === 0) date = 'invalid_date_string'; 
    if (i % 500 === 0) icd = null; 

    stmtEnc.run(ptId, prvId, date, complaintObj.text, icd, stat);
    
    // Insert Vitals
    let height = randInt(60, 78);
    let weight = randInt(100, 300);
    let sys = randInt(100, 160);
    let dia = randInt(60, 100);
    
    // Dirty vitals
    if (i % 600 === 0) weight = -150; // Negative weight
    if (i % 700 === 0) sys = 999; // impossible BP
    
    let bmi = null;
    if (weight > 0 && height > 0) {
      bmi = (weight / (height * height)) * 703;
    }

    stmtVtl.run(currentEncounterId, height, weight, sys, dia, bmi ? parseFloat(bmi.toFixed(2)) : null);

    // Only completed encounters usually get billed
    if (stat.trim().toUpperCase() === 'COMPLETED' || stat.trim().toUpperCase() === 'NO_SHOW') {
      validClaims.push(currentEncounterId);
    }
    currentEncounterId++;
  }
  stmtEnc.finalize();
  stmtVtl.finalize();

  // Insert Claims (For the valid encounters)
  const stmtClm = db.prepare(`INSERT INTO TBL_CLM_FIN_DTL (SYS_ENC_ID_REF, TOT_CHG_AMT, PT_RESP_AMT, CLM_STAT_CD) VALUES (?, ?, ?, ?)`);
  const claimStatuses = ['PAID', 'PENDING', 'DENIED'];
  
  validClaims.forEach((encId, index) => {
    let totChg = randInt(100, 5000);
    let ptResp = Math.floor(totChg * randElem([0, 0.1, 0.2, 0.5, 1]));
    let stat = randElem(claimStatuses);

    // Dirty data
    if (index % 100 === 0) totChg = -150.00; 
    if (index % 150 === 0) ptResp = totChg + 50; 
    if (index % 250 === 0) stat = 'Paid'; 
    
    stmtClm.run(encId, totChg, ptResp, stat);
  });
  stmtClm.finalize();

  console.log('Successfully created convoluted healthcare schema and seeded THOUSANDS of rows of (sometimes dirty) data!');
});

db.close();
