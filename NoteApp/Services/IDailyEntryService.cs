using NoteApp.Models;

namespace NoteApp.Services
{

    public interface IDailyEntryService
    {
        void AddEntry(DailyEntry entry);
        void UpdateEntry(DailyEntry entry);
        void DeleteEntry(int id, string? deletedBy);
        DailyEntry? GetEntryById(int id);
        List<DailyEntry> GetEntriesByNoteId(int noteId);
    }

}
