import Vapor
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

func isWord(_ word: String) async throws -> Bool {
    if word.count < 3 {return false}

    let (data, _) = try await URLSession.shared.data(from: URL(string:"https://api.dictionaryapi.dev/api/v2/entries/en/\(word.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "hbib")") ?? URL(string: "https://api.dictionaryapi.dev/api/v2/entries/en/hjihre")!)

    if let _ = try? JSONDecoder().decode([WordEntry].self, from: data){
        return true
    }
    let responseString = String(data: data, encoding: .utf8) ?? "none"
    if responseString == #"{"title":"No Definitions Found","message":"Sorry pal, we couldn't find definitions for the word you were looking for.","resolution":"You can try the search again at later time or head to the web instead."}"# {
        return false
    } else if responseString.contains(word) {
        return true
    }

    Logger(label: "game.isword").info("isWord failed sleeping ten seconds for word: \(word) response: \(responseString)")
    try await Task.sleep(nanoseconds: 10*1_000_000_000)
    return try await isWord(word)
}

struct WordEntry: Codable, Hashable {
    let word: String
    let phonetic: String?
    let phonetics: [Phonetic]
    let origin: String?
    let meanings: [Meaning]
}

struct Phonetic: Codable, Hashable {
    let text: String?
    let audio: String?
}

struct Meaning: Codable, Hashable {
    let partOfSpeech: String
    let definitions: [Definition]
}

struct Definition: Codable, Hashable {
    let definition: String
    let example: String?
    let synonyms: [String]
    let antonyms: [String]
}

enum APIError: Error {
    case invalidURL
    case requestFailed
    case invalidResponse
    case decodingError
    case wordEmpty
}

struct DatamuseWord : Decodable {
    let word: String
}

func searchWordsContaining(string: String) async throws -> [String] {
    let urlString = "https://api.datamuse.com/words?sp=\(string)*"

    guard let url = URL(string: urlString) else {
        throw APIError.invalidURL
    }

    let (data, _) = try await URLSession.shared.data(from: url)
    let decoder = JSONDecoder()

    do {
        let response = try decoder.decode([DatamuseWord].self, from: data)
        return response.map { $0.word }
    } catch {
        throw APIError.decodingError
    }
}

