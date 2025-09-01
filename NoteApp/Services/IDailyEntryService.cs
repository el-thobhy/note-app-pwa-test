using NoteApp.Models;

namespace NoteApp.Services
{

    public interface IDailyEntryService
    {
        void AddEntry(DailyEntry entry);
        void UpdateEntry(DailyEntry entry);
        void UpdateDate(int id, string date, string modified_by);
        void DeleteEntry(int id, string? deletedBy);
        DailyEntry? GetEntryById(int id);
        List<DailyEntry> GetEntriesByNoteId(int noteId);
    }

}
