#define NOMINMAX
#include <Windows.h>
#include <dia2.h>

#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

struct field_t {
    std::wstring name;
    std::wstring type;
    std::wstring value;
    bool has_value = false;
    uint64_t offset_bits = 0;
    uint64_t size_bits = 0;
};

struct type_t {
    std::wstring name;
    std::wstring kind;
    std::wstring underlying_type;
    uint64_t size = 0;
    uint64_t alignment = 1;
    std::vector<field_t> fields;
};

struct parameter_t {
    std::wstring name;
    std::wstring type;
};

struct function_t {
    std::wstring name;
    std::wstring return_type = L"unknown";
    std::wstring calling_convention = L"unknown";
    uint64_t rva = 0;
    uint64_t size = 0;
    bool is_public = false;
    std::vector<parameter_t> parameters;
};

template <class T>
void release_if(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

std::wstring bstr_to_wstring(BSTR value) {
    if (!value) { return L""; }
    std::wstring text(value, SysStringLen(value));
    SysFreeString(value);
    return text;
}

std::wstring get_name(IDiaSymbol* symbol) {
    BSTR name = nullptr;
    if (!symbol || FAILED(symbol->get_name(&name))) { return L""; }
    return bstr_to_wstring(name);
}

std::wstring get_function_name(IDiaSymbol* symbol) {
    if (!symbol) { return L""; }
    const std::wstring raw = get_name(symbol);
    const bool decorated = !raw.empty() && (raw[0] == L'?' || (raw[0] == L'_' && raw.find(L'@') != std::wstring::npos));
    if (!raw.empty() && !decorated) { return raw; }
    BSTR name = nullptr;
    if (SUCCEEDED(symbol->get_undecoratedName(&name)) && name) {
        std::wstring value = bstr_to_wstring(name);
        if (!value.empty()) { return value; }
    }
    return raw;
}

std::wstring json_escape(const std::wstring& text) {
    std::wstringstream out;
    for (wchar_t ch : text) {
        switch (ch) {
            case L'\\': out << L"\\\\"; break;
            case L'"': out << L"\\\""; break;
            case L'\n': out << L"\\n"; break;
            case L'\r': out << L"\\r"; break;
            case L'\t': out << L"\\t"; break;
            default: out << ch; break;
        }
    }
    return out.str();
}

std::wstring base_type_name(DWORD base_type, ULONGLONG length) {
    switch (base_type) {
        case btVoid: return L"void";
        case btChar: return L"char";
        case btWChar: return L"wchar_t";
        case btInt:
            if (length == 1) { return L"int8_t"; }
            if (length == 2) { return L"int16_t"; }
            if (length == 4) { return L"int32_t"; }
            if (length == 8) { return L"int64_t"; }
            return L"int";
        case btUInt:
            if (length == 1) { return L"uint8_t"; }
            if (length == 2) { return L"uint16_t"; }
            if (length == 4) { return L"uint32_t"; }
            if (length == 8) { return L"uint64_t"; }
            return L"unsigned int";
        case btBool: return L"bool";
        case btLong: return length == 8 ? L"int64_t" : L"long";
        case btULong: return length == 8 ? L"uint64_t" : L"unsigned long";
        case btFloat: return length == 8 ? L"double" : L"float";
        case btHresult: return L"HRESULT";
        default: return L"void";
    }
}

std::wstring format_type(IDiaSymbol* symbol) {
    if (!symbol) { return L"void"; }

    DWORD tag = SymTagNull;
    symbol->get_symTag(&tag);

    if (tag == SymTagPointerType) {
        IDiaSymbol* inner = nullptr;
        std::wstring inner_type = L"void";
        if (SUCCEEDED(symbol->get_type(&inner)) && inner) {
            inner_type = format_type(inner);
        }
        release_if(inner);
        return inner_type + L"*";
    }

    if (tag == SymTagArrayType) {
        IDiaSymbol* inner = nullptr;
        std::wstring inner_type = L"void";
        if (SUCCEEDED(symbol->get_type(&inner)) && inner) {
            inner_type = format_type(inner);
        }
        DWORD count = 0;
        symbol->get_count(&count);
        release_if(inner);
        return inner_type + L"[" + std::to_wstring(count) + L"]";
    }

    if (tag == SymTagBaseType) {
        DWORD base_type = btNoType;
        ULONGLONG length = 0;
        symbol->get_baseType(&base_type);
        symbol->get_length(&length);
        return base_type_name(base_type, length);
    }

    std::wstring name = get_name(symbol);
    if (!name.empty()) { return name; }
    return L"void";
}

std::wstring clean_alias(std::wstring name) {
    if (!name.empty() && name[0] == L'_') {
        name.erase(name.begin());
    }
    return name;
}

std::wstring c_identifier(const std::wstring& value) {
    std::wstring output;
    output.reserve(value.size() + 1);
    for (const wchar_t ch : value) {
        const wchar_t next = (std::iswalnum(ch) || ch == L'_') ? ch : L'_';
        if (next == L'_' && !output.empty() && output.back() == L'_') { continue; }
        output.push_back(next);
    }
    if (output.empty()) { output = L"anonymous_type"; }
    if (std::iswdigit(output[0])) { output.insert(output.begin(), L'_'); }
    return output;
}

std::wstring render_field(const field_t& field) {
    std::wstring type = field.type;
    std::wstring suffix;
    const size_t array_pos = type.find(L'[');
    if (array_pos != std::wstring::npos) {
        suffix = type.substr(array_pos);
        type = type.substr(0, array_pos);
    }
    if (type.empty() || type.find(L'<') != std::wstring::npos) {
        type = L"uint8_t";
    }
    return type + L" " + c_identifier(field.name) + suffix;
}

std::wstring render_c(const type_t& type) {
    std::wstringstream out;
    const std::wstring type_name = c_identifier(type.name);
    if (type.kind == L"typedef") {
        const std::wstring underlying = type.underlying_type.empty() || type.underlying_type.find(L'<') != std::wstring::npos ? L"void*" : type.underlying_type;
        out << L"typedef " << underlying << L" " << type_name << L";";
        return out.str();
    }
    if (type.kind == L"enum") {
        out << L"typedef enum " << type_name << L" {\n";
        for (size_t index = 0; index < type.fields.size(); index += 1) {
            const auto& field = type.fields[index];
            out << L"    " << c_identifier(field.name);
            if (field.has_value) { out << L" = " << field.value; }
            if (index + 1 < type.fields.size()) { out << L","; }
            out << L"\n";
        }
        out << L"} " << c_identifier(clean_alias(type.name)) << L";";
        return out.str();
    }
    out << L"typedef " << (type.kind == L"union" ? L"union" : L"struct") << L" " << type_name << L" {\n";
    for (const auto& field : type.fields) {
        out << L"    " << render_field(field) << L";";
        out << L" // 0x" << std::hex << (field.offset_bits / 8) << std::dec << L"\n";
    }
    out << L"} " << c_identifier(clean_alias(type.name)) << L", *P" << c_identifier(clean_alias(type.name)) << L";";
    return out.str();
}

std::wstring variant_value(const VARIANT& value) {
    switch (value.vt) {
        case VT_I1: return std::to_wstring(value.cVal);
        case VT_UI1: return std::to_wstring(value.bVal);
        case VT_I2: return std::to_wstring(value.iVal);
        case VT_UI2: return std::to_wstring(value.uiVal);
        case VT_I4:
        case VT_INT: return std::to_wstring(value.lVal);
        case VT_UI4:
        case VT_UINT: return std::to_wstring(value.ulVal);
        case VT_I8: return std::to_wstring(value.llVal);
        case VT_UI8: return std::to_wstring(value.ullVal);
        case VT_BOOL: return value.boolVal == VARIANT_TRUE ? L"1" : L"0";
        default: return L"";
    }
}

uint64_t inferred_alignment(const type_t& type) {
    uint64_t alignment = 1;
    for (const auto& field : type.fields) {
        const uint64_t bytes = std::max<uint64_t>(1, field.size_bits / 8);
        uint64_t candidate = 1;
        while (candidate < bytes && candidate < 16) { candidate *= 2; }
        alignment = std::max(alignment, candidate);
    }
    if (type.size > 0) { alignment = std::min(alignment, type.size); }
    return std::max<uint64_t>(1, alignment);
}

bool load_dia(const wchar_t* dia_path, const wchar_t* pdb_path, IDiaDataSource** source, IDiaSession** session, IDiaSymbol** global) {
    using dll_get_class_object_t = HRESULT (STDAPICALLTYPE*)(REFCLSID, REFIID, LPVOID*);

    HMODULE dia = LoadLibraryW(dia_path);
    if (!dia) {
        std::wcerr << L"LoadLibrary failed for " << dia_path << L"\n";
        return false;
    }

    auto get_class_object = reinterpret_cast<dll_get_class_object_t>(GetProcAddress(dia, "DllGetClassObject"));
    if (!get_class_object) {
        std::wcerr << L"DllGetClassObject missing\n";
        return false;
    }

    CoInitialize(nullptr);

    IClassFactory* factory = nullptr;
    HRESULT hr = get_class_object(__uuidof(DiaSource), IID_IClassFactory, reinterpret_cast<void**>(&factory));
    if (FAILED(hr) || !factory) {
        std::wcerr << L"DllGetClassObject failed: 0x" << std::hex << hr << std::dec << L"\n";
        return false;
    }

    hr = factory->CreateInstance(nullptr, __uuidof(IDiaDataSource), reinterpret_cast<void**>(source));
    release_if(factory);
    if (FAILED(hr) || !*source) {
        std::wcerr << L"CreateInstance failed: 0x" << std::hex << hr << std::dec << L"\n";
        return false;
    }

    hr = (*source)->loadDataFromPdb(pdb_path);
    if (FAILED(hr)) {
        std::wcerr << L"loadDataFromPdb failed: 0x" << std::hex << hr << std::dec << L"\n";
        return false;
    }

    hr = (*source)->openSession(session);
    if (FAILED(hr) || !*session) {
        std::wcerr << L"openSession failed: 0x" << std::hex << hr << std::dec << L"\n";
        return false;
    }

    hr = (*session)->get_globalScope(global);
    if (FAILED(hr) || !*global) {
        std::wcerr << L"get_globalScope failed: 0x" << std::hex << hr << std::dec << L"\n";
        return false;
    }

    return true;
}

bool extract_type(IDiaSymbol* global, const std::wstring& name, type_t& out_type) {
    IDiaEnumSymbols* enum_symbols = nullptr;
    HRESULT hr = global->findChildren(SymTagUDT, name.c_str(), nsCaseSensitive, &enum_symbols);
    if (FAILED(hr) || !enum_symbols) { return false; }

    IDiaSymbol* udt = nullptr;
    ULONG fetched = 0;
    hr = enum_symbols->Next(1, &udt, &fetched);
    release_if(enum_symbols);
    if (FAILED(hr) || fetched != 1 || !udt) { return false; }

    out_type.name = get_name(udt);
    ULONGLONG length = 0;
    udt->get_length(&length);
    out_type.size = length;

    DWORD udt_kind = UdtStruct;
    udt->get_udtKind(&udt_kind);
    out_type.kind = udt_kind == UdtUnion ? L"union" : L"struct";

    IDiaEnumSymbols* fields = nullptr;
    if (SUCCEEDED(udt->findChildren(SymTagData, nullptr, nsNone, &fields)) && fields) {
        IDiaSymbol* field_symbol = nullptr;
        while (SUCCEEDED(fields->Next(1, &field_symbol, &fetched)) && fetched == 1 && field_symbol) {
            DWORD data_kind = DataIsUnknown;
            field_symbol->get_dataKind(&data_kind);
            if (data_kind == DataIsMember) {
                field_t field;
                field.name = get_name(field_symbol);

                LONG offset = 0;
                field_symbol->get_offset(&offset);
                field.offset_bits = static_cast<uint64_t>(std::max<LONG>(0, offset)) * 8;

                IDiaSymbol* field_type = nullptr;
                if (SUCCEEDED(field_symbol->get_type(&field_type)) && field_type) {
                    field.type = format_type(field_type);
                    ULONGLONG field_len = 0;
                    if (SUCCEEDED(field_type->get_length(&field_len))) {
                        field.size_bits = field_len * 8;
                    }
                }
                release_if(field_type);

                if (field.size_bits == 0) {
                    ULONGLONG field_len = 0;
                    if (SUCCEEDED(field_symbol->get_length(&field_len))) {
                        field.size_bits = field_len * 8;
                    }
                }

                if (!field.name.empty()) {
                    out_type.fields.push_back(field);
                }
            }
            release_if(field_symbol);
        }
    }
    release_if(fields);
    release_if(udt);

    std::sort(out_type.fields.begin(), out_type.fields.end(), [](const field_t& left, const field_t& right) {
        if (left.offset_bits != right.offset_bits) { return left.offset_bits < right.offset_bits; }
        return left.name < right.name;
    });
    out_type.alignment = inferred_alignment(out_type);
    return true;
}

bool extract_udt(IDiaSymbol* udt, type_t& out_type) {
    if (!udt) { return false; }

    out_type.name = get_name(udt);
    if (out_type.name.empty()) { return false; }

    ULONGLONG length = 0;
    udt->get_length(&length);
    out_type.size = length;

    DWORD udt_kind = UdtStruct;
    udt->get_udtKind(&udt_kind);
    out_type.kind = udt_kind == UdtUnion ? L"union" : L"struct";

    IDiaEnumSymbols* fields = nullptr;
    ULONG fetched = 0;
    if (SUCCEEDED(udt->findChildren(SymTagData, nullptr, nsNone, &fields)) && fields) {
        IDiaSymbol* field_symbol = nullptr;
        while (SUCCEEDED(fields->Next(1, &field_symbol, &fetched)) && fetched == 1 && field_symbol) {
            DWORD data_kind = DataIsUnknown;
            field_symbol->get_dataKind(&data_kind);
            if (data_kind == DataIsMember) {
                field_t field;
                field.name = get_name(field_symbol);

                LONG offset = 0;
                field_symbol->get_offset(&offset);
                field.offset_bits = static_cast<uint64_t>(std::max<LONG>(0, offset)) * 8;

                IDiaSymbol* field_type = nullptr;
                if (SUCCEEDED(field_symbol->get_type(&field_type)) && field_type) {
                    field.type = format_type(field_type);
                    ULONGLONG field_len = 0;
                    if (SUCCEEDED(field_type->get_length(&field_len))) {
                        field.size_bits = field_len * 8;
                    }
                }
                release_if(field_type);

                if (field.size_bits == 0) {
                    ULONGLONG field_len = 0;
                    if (SUCCEEDED(field_symbol->get_length(&field_len))) {
                        field.size_bits = field_len * 8;
                    }
                }

                if (!field.name.empty()) {
                    out_type.fields.push_back(field);
                }
            }
            release_if(field_symbol);
        }
    }
    release_if(fields);

    std::sort(out_type.fields.begin(), out_type.fields.end(), [](const field_t& left, const field_t& right) {
        if (left.offset_bits != right.offset_bits) { return left.offset_bits < right.offset_bits; }
        return left.name < right.name;
    });
    out_type.alignment = inferred_alignment(out_type);
    return true;
}

bool extract_enum(IDiaSymbol* symbol, type_t& out_type) {
    if (!symbol) { return false; }
    out_type.name = get_name(symbol);
    if (out_type.name.empty()) { return false; }
    out_type.kind = L"enum";

    IDiaSymbol* underlying = nullptr;
    if (SUCCEEDED(symbol->get_type(&underlying)) && underlying) {
        out_type.underlying_type = format_type(underlying);
        ULONGLONG length = 0;
        if (SUCCEEDED(underlying->get_length(&length))) { out_type.size = length; }
    }
    release_if(underlying);
    if (out_type.size == 0) {
        ULONGLONG length = 0;
        if (SUCCEEDED(symbol->get_length(&length))) { out_type.size = length; }
    }
    out_type.alignment = std::max<uint64_t>(1, std::min<uint64_t>(out_type.size, 8));

    IDiaEnumSymbols* members = nullptr;
    ULONG fetched = 0;
    if (SUCCEEDED(symbol->findChildren(SymTagData, nullptr, nsNone, &members)) && members) {
        IDiaSymbol* member = nullptr;
        while (SUCCEEDED(members->Next(1, &member, &fetched)) && fetched == 1 && member) {
            DWORD data_kind = DataIsUnknown;
            member->get_dataKind(&data_kind);
            if (data_kind == DataIsConstant) {
                field_t field;
                field.name = get_name(member);
                field.type = out_type.underlying_type;
                field.size_bits = out_type.size * 8;
                VARIANT value;
                VariantInit(&value);
                if (SUCCEEDED(member->get_value(&value))) {
                    field.value = variant_value(value);
                    field.has_value = !field.value.empty();
                }
                VariantClear(&value);
                if (!field.name.empty()) { out_type.fields.push_back(field); }
            }
            release_if(member);
        }
    }
    release_if(members);
    return true;
}

bool extract_typedef(IDiaSymbol* symbol, type_t& out_type) {
    if (!symbol) { return false; }
    out_type.name = get_name(symbol);
    if (out_type.name.empty()) { return false; }
    out_type.kind = L"typedef";
    IDiaSymbol* underlying = nullptr;
    if (SUCCEEDED(symbol->get_type(&underlying)) && underlying) {
        out_type.underlying_type = format_type(underlying);
        ULONGLONG length = 0;
        if (SUCCEEDED(underlying->get_length(&length))) { out_type.size = length; }
    }
    release_if(underlying);
    if (out_type.underlying_type.empty()) { return false; }
    out_type.alignment = std::max<uint64_t>(1, std::min<uint64_t>(out_type.size, 16));
    return true;
}

std::vector<type_t> extract_all_types(IDiaSymbol* global) {
    std::map<std::wstring, type_t> unique;
    const auto add_type = [&unique](type_t&& type) {
        const std::wstring key = type.kind + L"\n" + type.name;
        auto current = unique.find(key);
        if (current == unique.end() || type.fields.size() > current->second.fields.size() || type.size > current->second.size) {
            unique[key] = std::move(type);
        }
    };

    const auto collect = [&](DWORD tag, bool (*extractor)(IDiaSymbol*, type_t&)) {
        IDiaEnumSymbols* symbols = nullptr;
        if (FAILED(global->findChildren(static_cast<enum SymTagEnum>(tag), nullptr, nsNone, &symbols)) || !symbols) { return; }
        IDiaSymbol* symbol = nullptr;
        ULONG fetched = 0;
        while (SUCCEEDED(symbols->Next(1, &symbol, &fetched)) && fetched == 1 && symbol) {
            type_t type;
            if (extractor(symbol, type)) { add_type(std::move(type)); }
            release_if(symbol);
        }
        release_if(symbols);
    };

    collect(SymTagUDT, extract_udt);
    collect(SymTagEnum, extract_enum);
    collect(SymTagTypedef, extract_typedef);

    std::vector<type_t> types;
    types.reserve(unique.size());
    for (auto& entry : unique) { types.push_back(std::move(entry.second)); }
    std::sort(types.begin(), types.end(), [](const type_t& left, const type_t& right) {
        if (left.name != right.name) { return left.name < right.name; }
        return left.kind < right.kind;
    });
    return types;
}

std::wstring calling_convention_name(DWORD convention) {
    switch (convention) {
        case CV_CALL_NEAR_C: return L"cdecl";
        case CV_CALL_NEAR_FAST: return L"fastcall";
        case CV_CALL_NEAR_STD: return L"stdcall";
        case CV_CALL_NEAR_SYS: return L"syscall";
        case CV_CALL_THISCALL: return L"thiscall";
        case CV_CALL_NEAR_VECTOR: return L"vectorcall";
        default: return L"unknown";
    }
}

bool extract_function(IDiaSymbol* symbol, bool public_symbol, function_t& function) {
    if (!symbol) { return false; }
    if (public_symbol) {
        BOOL code = FALSE;
        if (FAILED(symbol->get_code(&code)) || !code) { return false; }
    }
    DWORD rva = 0;
    if (FAILED(symbol->get_relativeVirtualAddress(&rva)) || rva == 0) { return false; }
    function.name = get_function_name(symbol);
    if (function.name.empty()) { return false; }
    function.rva = rva;
    function.is_public = public_symbol;
    ULONGLONG length = 0;
    if (SUCCEEDED(symbol->get_length(&length))) { function.size = length; }

    IDiaSymbol* function_type = nullptr;
    if (SUCCEEDED(symbol->get_type(&function_type)) && function_type) {
        IDiaSymbol* return_type = nullptr;
        if (SUCCEEDED(function_type->get_type(&return_type)) && return_type) {
            function.return_type = format_type(return_type);
        }
        release_if(return_type);
        DWORD convention = 0;
        if (SUCCEEDED(function_type->get_callingConvention(&convention))) {
            function.calling_convention = calling_convention_name(convention);
        }
    }

    IDiaEnumSymbols* parameters = nullptr;
    ULONG fetched = 0;
    if (SUCCEEDED(symbol->findChildren(SymTagData, nullptr, nsNone, &parameters)) && parameters) {
        IDiaSymbol* parameter_symbol = nullptr;
        while (SUCCEEDED(parameters->Next(1, &parameter_symbol, &fetched)) && fetched == 1 && parameter_symbol) {
            DWORD data_kind = DataIsUnknown;
            parameter_symbol->get_dataKind(&data_kind);
            if (data_kind == DataIsParam) {
                parameter_t parameter;
                parameter.name = get_name(parameter_symbol);
                IDiaSymbol* parameter_type = nullptr;
                if (SUCCEEDED(parameter_symbol->get_type(&parameter_type)) && parameter_type) {
                    parameter.type = format_type(parameter_type);
                }
                release_if(parameter_type);
                if (parameter.name.empty()) { parameter.name = L"arg" + std::to_wstring(function.parameters.size()); }
                if (parameter.type.empty()) { parameter.type = L"unknown"; }
                function.parameters.push_back(parameter);
            }
            release_if(parameter_symbol);
        }
    }
    release_if(parameters);

    if (function.parameters.empty() && function_type) {
        IDiaEnumSymbols* argument_types = nullptr;
        if (SUCCEEDED(function_type->findChildren(SymTagFunctionArgType, nullptr, nsNone, &argument_types)) && argument_types) {
            IDiaSymbol* argument = nullptr;
            while (SUCCEEDED(argument_types->Next(1, &argument, &fetched)) && fetched == 1 && argument) {
                parameter_t parameter;
                parameter.name = L"arg" + std::to_wstring(function.parameters.size());
                IDiaSymbol* argument_type = nullptr;
                if (SUCCEEDED(argument->get_type(&argument_type)) && argument_type) { parameter.type = format_type(argument_type); }
                release_if(argument_type);
                if (parameter.type.empty()) { parameter.type = L"unknown"; }
                function.parameters.push_back(parameter);
                release_if(argument);
            }
        }
        release_if(argument_types);
    }
    release_if(function_type);
    return true;
}

std::vector<function_t> extract_all_functions(IDiaSymbol* global) {
    std::map<std::wstring, function_t> unique;
    const auto collect = [&](DWORD tag, bool is_public) {
        IDiaEnumSymbols* symbols = nullptr;
        if (FAILED(global->findChildren(static_cast<enum SymTagEnum>(tag), nullptr, nsNone, &symbols)) || !symbols) { return; }
        IDiaSymbol* symbol = nullptr;
        ULONG fetched = 0;
        while (SUCCEEDED(symbols->Next(1, &symbol, &fetched)) && fetched == 1 && symbol) {
            function_t function;
            if (extract_function(symbol, is_public, function)) {
                const std::wstring key = std::to_wstring(function.rva) + L"\n" + function.name;
                auto current = unique.find(key);
                if (current == unique.end() || function.parameters.size() > current->second.parameters.size() || (!is_public && current->second.is_public)) {
                    unique[key] = std::move(function);
                }
            }
            release_if(symbol);
        }
        release_if(symbols);
    };

    collect(SymTagFunction, false);
    collect(SymTagPublicSymbol, true);
    std::vector<function_t> functions;
    functions.reserve(unique.size());
    for (auto& entry : unique) { functions.push_back(std::move(entry.second)); }
    std::sort(functions.begin(), functions.end(), [](const function_t& left, const function_t& right) {
        if (left.rva != right.rva) { return left.rva < right.rva; }
        return left.name < right.name;
    });
    for (size_t index = 0; index + 1 < functions.size(); index += 1) {
        if (functions[index].size == 0 && functions[index + 1].rva > functions[index].rva) {
            functions[index].size = functions[index + 1].rva - functions[index].rva;
        }
    }
    return functions;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 3) {
        std::wcerr << L"usage: pdb_dump <msdia140.dll> <pdb> [type...]\n";
        return 1;
    }

    IDiaDataSource* source = nullptr;
    IDiaSession* session = nullptr;
    IDiaSymbol* global = nullptr;
    if (!load_dia(argv[1], argv[2], &source, &session, &global)) {
        release_if(global);
        release_if(session);
        release_if(source);
        CoUninitialize();
        return 1;
    }

    std::vector<type_t> types = argc == 3 ? extract_all_types(global) : std::vector<type_t>();
    std::vector<function_t> functions = argc == 3 ? extract_all_functions(global) : std::vector<function_t>();
    if (argc > 3) {
        for (int index = 3; index < argc; index += 1) {
            type_t type;
            if (extract_type(global, argv[index], type)) {
                types.push_back(type);
            }
        }
    }

    std::wcout << L"{\"types\":[";
    for (size_t index = 0; index < types.size(); index += 1) {
        const auto& type = types[index];
        if (index != 0) { std::wcout << L","; }
        std::wcout << L"{\"name\":\"" << json_escape(type.name) << L"\",";
        std::wcout << L"\"kind\":\"" << type.kind << L"\",";
        std::wcout << L"\"size\":" << type.size << L",";
        std::wcout << L"\"alignment\":" << type.alignment << L",";
        std::wcout << L"\"underlying_type\":\"" << json_escape(type.underlying_type) << L"\",";
        std::wcout << L"\"reconstructed_c\":\"" << json_escape(render_c(type)) << L"\",";
        std::wcout << L"\"fields\":[";
        for (size_t field_index = 0; field_index < type.fields.size(); field_index += 1) {
            const auto& field = type.fields[field_index];
            if (field_index != 0) { std::wcout << L","; }
            std::wcout << L"{\"name\":\"" << json_escape(field.name) << L"\",";
            std::wcout << L"\"field_type_name\":\"" << json_escape(field.type) << L"\",";
            std::wcout << L"\"offset_bits\":" << field.offset_bits << L",";
            std::wcout << L"\"size_bits\":" << field.size_bits;
            if (field.has_value) { std::wcout << L",\"value\":\"" << json_escape(field.value) << L"\""; }
            std::wcout << L"}";
        }
        std::wcout << L"]}";
    }
    std::wcout << L"],\"functions\":[";
    for (size_t index = 0; index < functions.size(); index += 1) {
        const auto& function = functions[index];
        if (index != 0) { std::wcout << L","; }
        std::wcout << L"{\"name\":\"" << json_escape(function.name) << L"\",";
        std::wcout << L"\"return_type\":\"" << json_escape(function.return_type) << L"\",";
        std::wcout << L"\"calling_convention\":\"" << json_escape(function.calling_convention) << L"\",";
        std::wcout << L"\"rva\":\"0x" << std::hex << function.rva << std::dec << L"\",";
        std::wcout << L"\"size\":" << function.size << L",";
        std::wcout << L"\"is_public\":" << (function.is_public ? L"true" : L"false") << L",";
        std::wcout << L"\"parameters\":[";
        for (size_t parameter_index = 0; parameter_index < function.parameters.size(); parameter_index += 1) {
            const auto& parameter = function.parameters[parameter_index];
            if (parameter_index != 0) { std::wcout << L","; }
            std::wcout << L"{\"name\":\"" << json_escape(parameter.name) << L"\",";
            std::wcout << L"\"type\":\"" << json_escape(parameter.type) << L"\"}";
        }
        std::wcout << L"]}";
    }
    std::wcout << L"]}";

    release_if(global);
    release_if(session);
    release_if(source);
    CoUninitialize();
    return 0;
}
