use std::env;
use std::fs;
use std::process;

struct Section {
    name: String,
    virtual_address: u32,
    virtual_size: u32,
    raw_size: u32,
}

struct PeSummary {
    machine: u16,
    sections: u16,
    timestamp: u32,
    image_base: u64,
    image_size: u32,
    pdb_path_hint: String,
    section_table: Vec<Section>,
}

fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let bytes = data.get(offset..end)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let bytes = data.get(offset..end)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u64(data: &[u8], offset: usize) -> Option<u64> {
    let end = offset.checked_add(8)?;
    let bytes = data.get(offset..end)?;
    Some(u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn get_range(data: &[u8], offset: usize, len: usize) -> Option<&[u8]> {
    let end = offset.checked_add(len)?;
    data.get(offset..end)
}

fn section_name(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

fn analyze(data: &[u8]) -> Result<PeSummary, String> {
    if data.get(0..2) != Some(b"MZ") {
        return Err("missing MZ header".to_string());
    }

    let pe_offset = read_u32(data, 0x3c).ok_or_else(|| "missing e_lfanew".to_string())? as usize;
    if get_range(data, pe_offset, 4) != Some(b"PE\0\0") {
        return Err("missing PE signature".to_string());
    }

    let coff = pe_offset.checked_add(4).ok_or_else(|| "PE offset overflow".to_string())?;
    let machine = read_u16(data, coff).ok_or_else(|| "missing machine".to_string())?;
    let sections = read_u16(data, coff + 2).ok_or_else(|| "missing section count".to_string())?;
    let timestamp = read_u32(data, coff + 4).ok_or_else(|| "missing timestamp".to_string())?;
    let optional_size = read_u16(data, coff + 16).ok_or_else(|| "missing optional header size".to_string())? as usize;
    let optional = coff.checked_add(20).ok_or_else(|| "optional header offset overflow".to_string())?;
    let magic = read_u16(data, optional).ok_or_else(|| "missing optional header magic".to_string())?;
    let image_base = if magic == 0x20b {
        read_u64(data, optional + 24).ok_or_else(|| "missing pe32+ image base".to_string())?
    } else {
        read_u32(data, optional + 28).ok_or_else(|| "missing pe32 image base".to_string())? as u64
    };
    let image_size = read_u32(data, optional + 56).ok_or_else(|| "missing image size".to_string())?;
    let section_offset = optional.checked_add(optional_size).ok_or_else(|| "section table offset overflow".to_string())?;
    let mut section_table = Vec::new();

    for index in 0..sections as usize {
        let offset = index
            .checked_mul(40)
            .and_then(|delta| section_offset.checked_add(delta))
            .ok_or_else(|| "section offset overflow".to_string())?;
        let name_bytes = get_range(data, offset, 8).ok_or_else(|| "section table truncated".to_string())?;
        section_table.push(Section {
            name: section_name(name_bytes),
            virtual_size: read_u32(data, offset + 8).ok_or_else(|| "section virtual size truncated".to_string())?,
            virtual_address: read_u32(data, offset + 12).ok_or_else(|| "section virtual address truncated".to_string())?,
            raw_size: read_u32(data, offset + 16).ok_or_else(|| "section raw size truncated".to_string())?,
        });
    }

    Ok(PeSummary {
        machine,
        sections,
        timestamp,
        image_base,
        image_size,
        pdb_path_hint: find_pdb_hint(data),
        section_table,
    })
}

fn find_pdb_hint(data: &[u8]) -> String {
    let needle = b".pdb";
    if data.len() < needle.len() {
        return String::new();
    }

    for index in 0..=data.len() - needle.len() {
        let end = index + needle.len();
        if data[index..end].eq_ignore_ascii_case(needle) {
            let start = data[..index].iter().rposition(|byte| *byte == 0).map_or(0, |pos| pos + 1);
            let end = data[index..].iter().position(|byte| *byte == 0).map_or(data.len(), |pos| index + pos);
            return String::from_utf8_lossy(&data[start..end]).to_string();
        }
    }
    String::new()
}

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn to_json(summary: &PeSummary) -> String {
    let sections = summary
        .section_table
        .iter()
        .map(|section| {
            format!(
                "{{\"name\":\"{}\",\"virtual_address\":{},\"virtual_size\":{},\"raw_size\":{}}}",
                escape_json(&section.name),
                section.virtual_address,
                section.virtual_size,
                section.raw_size
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"machine\":{},\"sections\":{},\"timestamp\":{},\"image_base\":\"0x{:x}\",\"image_size\":{},\"pdb_path_hint\":\"{}\",\"section_table\":[{}]}}",
        summary.machine,
        summary.sections,
        summary.timestamp,
        summary.image_base,
        summary.image_size,
        escape_json(&summary.pdb_path_hint),
        sections
    )
}

fn main() {
    let Some(path) = env::args().nth(1) else {
        eprintln!("usage: kernelarchive-binary-analyzer <pe-file>");
        process::exit(1);
    };

    let data = match fs::read(path) {
        Ok(data) => data,
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    };

    match analyze(&data) {
        Ok(summary) => println!("{}", to_json(&summary)),
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    }
}
